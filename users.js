// Users page (admins only): add people, set their role and what they may do,
// reset passwords, disable or delete accounts, and jump to their stats.

function avatar(u, size = "") {
  const a = ib("span", `avatar ${size}`, flInitials(u.displayName));
  a.style.background = `linear-gradient(135deg, hsl(${hashHue(u.id)} 70% 52%), hsl(${(hashHue(u.id) + 40) % 360} 70% 45%))`;
  return a;
}
function hashHue(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

async function renderUsers() {
  const users = Object.values(await flGetUsers()).sort((a, b) => (a.role !== b.role ? (a.role === "admin" ? -1 : 1) : a.createdAt - b.createdAt));
  const table = $("usersTable");
  const head = ib("thead");
  const hr = ib("tr");
  ["User", "Role", ...Object.values(FL_PERMS), "Status", "Last sign-in", ""].forEach((t) => hr.append(ib("th", null, t)));
  head.append(hr);
  const body = ib("tbody");
  for (const u of users) {
    const tr = ib("tr", u.disabled ? "disabled-row" : "");
    const who = ib("td");
    const wrap = ib("div", "user-cell");
    const names = ib("div");
    names.append(ib("b", null, u.displayName + (u.id === me.id ? " (you)" : "")), ib("small", "muted", `@${u.username}`));
    wrap.append(avatar(u), names);
    who.append(wrap);
    tr.append(who);

    const roleTd = ib("td");
    const role = select({ member: "Member", admin: "Admin" }, u.role, async (v) => {
      try { await flUpdateUser(u.id, { role: v }); } catch (e) { alert(e.message); }
      renderUsers();
    });
    roleTd.append(role);
    tr.append(roleTd);

    for (const key of Object.keys(FL_PERMS)) {
      const td = ib("td", "center");
      const sw = ib("input", "switch");
      sw.type = "checkbox";
      sw.checked = u.role === "admin" || !!u.perms?.[key];
      sw.disabled = u.role === "admin";
      sw.title = u.role === "admin" ? "Admins can do everything" : FL_PERMS[key];
      sw.onchange = async () => { await flUpdateUser(u.id, { perms: { [key]: sw.checked } }); };
      td.append(sw);
      tr.append(td);
    }

    const st = ib("td");
    const stBtn = ib("button", "ghost small", u.disabled ? "Disabled · enable" : "Active · disable");
    stBtn.disabled = u.id === me.id;
    stBtn.onclick = async () => {
      try { await flUpdateUser(u.id, { disabled: !u.disabled }); } catch (e) { alert(e.message); }
      renderUsers();
    };
    st.append(stBtn);
    tr.append(st, ib("td", "muted", u.lastLoginAt ? flTimeAgo(u.lastLoginAt) : "never"));

    const act = ib("td");
    const btns = ib("div", "row-actions");
    const view = ib("button", "ghost small", "View stats");
    view.onclick = () => { viewUid = u.id; location.hash = "#overview"; render(); };
    const pw = ib("button", "ghost small", "Reset password");
    pw.onclick = async () => {
      const p = prompt(`New password for ${u.displayName} (8+ characters):`);
      if (p == null) return;
      try { await flSetPassword(u.id, p); $("usersMsg").textContent = `Password for ${u.displayName} changed.`; } catch (e) { $("usersMsg").textContent = e.message; }
    };
    const del = ib("button", "ghost small danger", "Delete");
    del.disabled = u.id === me.id;
    del.onclick = async () => {
      if (!confirm(`Delete ${u.displayName}'s account and all of their tracked time? This can't be undone.`)) return;
      try { await flDeleteUser(u.id); if (viewUid === u.id) viewUid = me.id; } catch (e) { $("usersMsg").textContent = e.message; }
      renderUsers();
    };
    btns.append(view, pw, del);
    act.append(btns);
    tr.append(act);
    body.append(tr);
  }
  table.replaceChildren(head, body);
  $("usersCount").textContent = `${flPlural(users.length, "account")} · ${flPlural(users.filter((u) => u.role === "admin").length, "admin")}`;
}

function initUsers() {
  $("addUserForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("usersMsg");
    try {
      const u = await flCreateUser({
        displayName: $("newName").value, username: $("newUsername").value,
        password: $("newPassword").value, role: $("newRole").value,
      });
      msg.textContent = `Added ${u.displayName}. They can sign in as @${u.username} with the password you set.`;
      e.target.reset();
      renderUsers();
    } catch (ex) {
      msg.textContent = ex.message;
    }
  });
}

// "My account" card in Settings (everyone).
function renderMyAccount() {
  $("myName").value = me.displayName;
  $("myUsername").textContent = `@${me.username} · ${me.role === "admin" ? "Admin" : "Member"}`;
}

function initMyAccount() {
  $("myAccountForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("myMsg");
    try {
      if ($("myNewPw").value) {
        const users = await flGetUsers();
        const u = users[me.id];
        const check = await flHashPassword($("myCurPw").value, u.salt, u.iterations);
        if (check.hash !== u.hash) throw new Error("Your current password isn't right.");
        await flSetPassword(me.id, $("myNewPw").value);
      }
      me = await flUpdateUser(me.id, { displayName: $("myName").value });
      $("myCurPw").value = $("myNewPw").value = "";
      msg.textContent = "Saved ✓";
      renderUserChip();
    } catch (ex) {
      msg.textContent = ex.message;
    }
  });
}
