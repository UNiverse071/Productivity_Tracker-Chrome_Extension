// User accounts for the extension.
//
// The first person to open the extension creates the admin account. The admin
// adds other users and decides what each one may do. Passwords are stored only
// as salted PBKDF2-SHA256 hashes. The signed-in user lives in
// chrome.storage.session (cleared when Chrome closes) unless they tick
// "Remember me", which keeps them signed in for 30 days. The last user's name
// is remembered so the sign-in form is pre-filled.
//
// Note: accounts keep people's data and controls apart on a shared Chrome
// profile. Someone with access to the profile's files or DevTools could still
// read raw storage, so this isn't protection against the computer's owner.

var FL_PERMS = {
  viewAgents: "See the Agent inbox",
  requestChanges: "Send change requests to agents",
  approvePermissions: "Approve or deny permission requests",
  pauseTracking: "Pause their own time tracking",
};
var FL_MEMBER_DEFAULT_PERMS = { viewAgents: true, requestChanges: true, approvePermissions: false, pauseTracking: true };
var FL_PBKDF2_ITERATIONS = 310000;
var FL_REMEMBER_DAYS = 30;
var FL_LOCK_AFTER = 5;           // failed sign-ins before a short lock
var FL_LOCK_MS = 30000;

function flB64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function flUnB64(s) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function flHashPassword(password, saltB64, iterations = FL_PBKDF2_ITERATIONS) {
  const salt = saltB64 ? flUnB64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return { salt: flB64(salt), hash: flB64(bits), iterations };
}

function flSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function flNormUsername(u) {
  return String(u || "").trim().toLowerCase();
}

function flValidateNewUser({ username, displayName, password }) {
  if (!/^[a-z0-9._-]{2,32}$/.test(flNormUsername(username))) return "Username: 2–32 letters, numbers, dots, dashes or underscores.";
  if (!String(displayName || "").trim()) return "Please enter a display name.";
  if (String(password || "").length < 8) return "Password: at least 8 characters.";
  return "";
}

// ---- storage ----------------------------------------------------------------

async function flGetUsers() {
  const { users } = await chrome.storage.local.get("users");
  return users || {};
}

async function flSaveUsers(users) {
  await chrome.storage.local.set({ users });
}

function flPublicUser(u) {
  if (!u) return null;
  const { salt, hash, iterations, ...rest } = u;
  return rest;
}

function flCan(user, perm) {
  if (!user || user.disabled) return false;
  return user.role === "admin" || !!user.perms?.[perm];
}

async function flHasAccounts() {
  return Object.keys(await flGetUsers()).length > 0;
}

async function flCreateUser({ username, displayName, password, role = "member", perms }) {
  const err = flValidateNewUser({ username, displayName, password });
  if (err) throw new Error(err);
  const users = await flGetUsers();
  const uname = flNormUsername(username);
  if (Object.values(users).some((u) => u.username === uname)) throw new Error("That username is already taken.");
  const id = `u${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  users[id] = {
    id, username: uname, displayName: String(displayName).trim().slice(0, 60),
    role: role === "admin" ? "admin" : "member",
    perms: { ...FL_MEMBER_DEFAULT_PERMS, ...(perms || {}) },
    disabled: false, createdAt: Date.now(), lastLoginAt: 0,
    ...(await flHashPassword(password)),
  };
  await flSaveUsers(users);
  return flPublicUser(users[id]);
}

function flAdminCount(users, exceptId) {
  return Object.values(users).filter((u) => u.role === "admin" && !u.disabled && u.id !== exceptId).length;
}

async function flUpdateUser(id, patch) {
  const users = await flGetUsers();
  const u = users[id];
  if (!u) throw new Error("No such user.");
  const demoting = (patch.role && patch.role !== "admin") || patch.disabled === true;
  if (u.role === "admin" && demoting && flAdminCount(users, id) === 0) throw new Error("There must always be at least one active admin.");
  if (patch.displayName != null) u.displayName = String(patch.displayName).trim().slice(0, 60) || u.displayName;
  if (patch.role) u.role = patch.role === "admin" ? "admin" : "member";
  if (patch.perms) u.perms = { ...u.perms, ...patch.perms };
  if (patch.disabled != null) u.disabled = !!patch.disabled;
  await flSaveUsers(users);
  if (u.disabled) await flEndSessionsFor(id);
  return flPublicUser(u);
}

async function flSetPassword(id, password) {
  if (String(password || "").length < 8) throw new Error("Password: at least 8 characters.");
  const users = await flGetUsers();
  if (!users[id]) throw new Error("No such user.");
  Object.assign(users[id], await flHashPassword(password));
  await flSaveUsers(users);
}

async function flDeleteUser(id, { deleteData = true } = {}) {
  const users = await flGetUsers();
  const u = users[id];
  if (!u) return;
  if (u.role === "admin" && flAdminCount(users, id) === 0) throw new Error("You can't delete the last admin.");
  delete users[id];
  await flSaveUsers(users);
  await flEndSessionsFor(id);
  if (deleteData) {
    const all = await chrome.storage.local.get(null);
    await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith(`day:${id}:`) || k === `prefs:${id}`));
  }
}

async function flEndSessionsFor(id) {
  const { auth } = await chrome.storage.session.get("auth");
  if (auth?.userId === id) await chrome.storage.session.remove("auth");
  const { remembered } = await chrome.storage.local.get("remembered");
  if (remembered?.userId === id) await chrome.storage.local.remove("remembered");
}

// ---- sessions ----------------------------------------------------------------

async function flLogin(username, password, remember) {
  const uname = flNormUsername(username);
  const { authFails = {} } = await chrome.storage.session.get("authFails");
  const f = authFails[uname];
  if (f && f.until > Date.now()) throw new Error(`Too many attempts. Try again in ${Math.ceil((f.until - Date.now()) / 1000)} s.`);

  const users = await flGetUsers();
  const u = Object.values(users).find((x) => x.username === uname);
  const check = await flHashPassword(String(password || ""), u?.salt, u?.iterations || FL_PBKDF2_ITERATIONS);
  if (!u || !flSafeEqual(check.hash, u.hash)) {
    const count = (f?.count || 0) + 1;
    authFails[uname] = { count, until: count >= FL_LOCK_AFTER ? Date.now() + FL_LOCK_MS : 0 };
    await chrome.storage.session.set({ authFails });
    throw new Error("Wrong username or password.");
  }
  if (u.disabled) throw new Error("This account is disabled. Ask your admin.");
  delete authFails[uname];
  u.lastLoginAt = Date.now();
  await flSaveUsers(users);
  await chrome.storage.session.set({ auth: { userId: u.id, at: Date.now() }, authFails });
  await chrome.storage.local.set({ lastUser: u.username });
  if (remember) await chrome.storage.local.set({ remembered: { userId: u.id, until: Date.now() + FL_REMEMBER_DAYS * 86400000 } });
  else await chrome.storage.local.remove("remembered");
  return flPublicUser(u);
}

async function flLogout() {
  await chrome.storage.session.remove(["auth", "live", "episode"]);
  await chrome.storage.local.remove("remembered");
}

// The signed-in user, restoring a "Remember me" session after a restart.
async function flCurrentUser() {
  const users = await flGetUsers();
  let { auth } = await chrome.storage.session.get("auth");
  if (!auth) {
    const { remembered } = await chrome.storage.local.get("remembered");
    if (remembered && remembered.until > Date.now() && users[remembered.userId]) {
      auth = { userId: remembered.userId, at: Date.now() };
      await chrome.storage.session.set({ auth });
    }
  }
  const u = auth && users[auth.userId];
  if (!u || u.disabled) return null;
  return flPublicUser(u);
}

// ---- per-user preferences ----------------------------------------------------

async function flGetPrefs(uid) {
  const k = `prefs:${uid}`;
  const got = await chrome.storage.local.get(k);
  return { theme: "auto", paused: false, ...(got[k] || {}) };
}

async function flSavePrefs(uid, patch) {
  const next = { ...(await flGetPrefs(uid)), ...patch };
  await chrome.storage.local.set({ [`prefs:${uid}`]: next });
  return next;
}

// Data recorded before accounts existed ("day:YYYY-MM-DD") becomes the first admin's.
async function flMigrateLegacyData(adminId) {
  const all = await chrome.storage.local.get(null);
  const legacy = Object.keys(all).filter((k) => /^day:\d{4}-\d{2}-\d{2}$/.test(k));
  if (legacy.length) {
    const moved = {};
    for (const k of legacy) moved[`day:${adminId}:${k.slice(4)}`] = all[k];
    await chrome.storage.local.set(moved);
    await chrome.storage.local.remove(legacy);
  }
  const s = all.settings || {};
  await flSavePrefs(adminId, { theme: s.theme || "auto", paused: !!s.paused });
}

// ---- sign-in / first-run screen -----------------------------------------------
// Renders into `mount` and resolves with the signed-in user.

function flAuthGate(mount) {
  return new Promise(async (resolve) => {
    const user = await flCurrentUser();
    if (user) { document.documentElement.classList.remove("locked"); return resolve(user); }
    const hasAccounts = await flHasAccounts();
    const { lastUser = "" } = await chrome.storage.local.get("lastUser");
    mount.hidden = false;
    document.documentElement.classList.add("locked");

    const h = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    };
    const field = (label, type, id, value = "", attrs = {}) => {
      const wrap = h("label", "auth-field");
      wrap.append(h("span", null, label));
      const input = h("input");
      Object.assign(input, { type, id, value, ...attrs });
      wrap.append(input);
      return wrap;
    };

    const card = h("form", "auth-card");
    const brand = h("div", "auth-brand");
    const logo = h("img");
    logo.src = "icons/icon48.png";
    logo.alt = "";
    brand.append(logo, h("b", null, "Focus Ledger"));
    card.append(brand);
    const err = h("div", "auth-error");

    if (!hasAccounts) {
      card.append(h("h1", null, "Create the admin account"),
        h("p", "muted", "The admin manages users, permission rules and settings. Anything already tracked in this browser will belong to this account."),
        field("Your name", "text", "authName", "", { autocomplete: "name", required: true }),
        field("Username", "text", "authUser", "", { autocomplete: "username", required: true, spellcheck: false }),
        field("Password (8+ characters)", "password", "authPass", "", { autocomplete: "new-password", required: true }),
        field("Confirm password", "password", "authPass2", "", { autocomplete: "new-password", required: true }),
        err, h("button", "primary wide", "Create admin and sign in"));
    } else {
      card.append(h("h1", null, lastUser ? "Welcome back" : "Sign in"),
        h("p", "muted", lastUser ? "Sign in to continue." : "Sign in with the account your admin gave you."),
        field("Username", "text", "authUser", lastUser, { autocomplete: "username", required: true, spellcheck: false }),
        field("Password", "password", "authPass", "", { autocomplete: "current-password", required: true }));
      const rem = h("label", "toggle-row");
      const remText = h("span");
      remText.append(h("b", null, "Remember me"), h("small", null, `Stay signed in on this browser for ${FL_REMEMBER_DAYS} days.`));
      const remBox = h("input", "switch");
      remBox.type = "checkbox";
      remBox.id = "authRemember";
      rem.append(remText, remBox);
      card.append(rem, err, h("button", "primary wide", "Sign in"));
    }

    if (globalThis.FL_DEMO && hasAccounts) card.append(h("p", "muted small-note", "Demo: sign in as alex (admin) or sam (member). Password: demo1234"));
    mount.replaceChildren(card);
    const $a = (id) => card.querySelector(`#${id}`);
    (hasAccounts && lastUser ? $a("authPass") : $a(hasAccounts ? "authUser" : "authName")).focus();

    card.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = "";
      const btn = card.querySelector("button");
      btn.disabled = true;
      try {
        let u;
        if (!hasAccounts) {
          if ($a("authPass").value !== $a("authPass2").value) throw new Error("The passwords don't match.");
          const created = await flCreateUser({ username: $a("authUser").value, displayName: $a("authName").value, password: $a("authPass").value, role: "admin" });
          await flMigrateLegacyData(created.id);
          u = await flLogin(created.username, $a("authPass").value, false);
        } else {
          u = await flLogin($a("authUser").value, $a("authPass").value, $a("authRemember").checked);
        }
        mount.hidden = true;
        mount.replaceChildren();
        document.documentElement.classList.remove("locked");
        resolve(u);
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
      }
    });
  });
}

function flInitials(name) {
  return String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
}
