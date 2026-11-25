// Staff requests page (quiz Q2/Q3). The server decides everything: who owns a record, its status and
// version, who may see it and which change is allowed. This page only shows what the server returns and
// sends the version it last saw, so a change based on old data is refused rather than overwriting.
(function () {
  if (!window.App) return;
  const h = CMS.h;
  const role = App.session.role;
  const isReviewer = role === "Manager";
  const STATUS_CLASS = { Pending: "pill-placed", "In Review": "pill-preparing", Resolved: "pill-ready", Rejected: "pill-cancelled" };
  const state = { search: "", category: "", status: "", sort: "newest", page: 1, pages: 1 };
  let current = null, rules = null, searchTimer = null;

  App.ready(function () {
    document.getElementById("requestsIntro").textContent = isReviewer
      ? "Claim a pending request to review it, then resolve or reject it. You see pending requests and the ones you claimed."
      : "Report a problem or ask for supplies. A manager reviews every request. You see only your own requests.";
    if (!isReviewer) setupForm();
    document.getElementById("fSearch").addEventListener("input", function (e) {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { state.search = e.target.value.trim(); state.page = 1; load(); }, 250);
    });
    ["Category", "Status", "Sort"].forEach(function (k) {
      document.getElementById("f" + k).addEventListener("change", function (e) { state[k.toLowerCase()] = e.target.value; state.page = 1; load(); });
    });
    document.getElementById("prevPage").addEventListener("click", function () { if (state.page > 1) { state.page -= 1; load(); } });
    document.getElementById("nextPage").addEventListener("click", function () { if (state.page < state.pages) { state.page += 1; load(); } });
    load();
  });

  function setupForm() {
    document.getElementById("newRequestPanel").hidden = false;
    const form = document.getElementById("requestForm");
    rules = Validate.attach(form, {
      rqTitle: { label: "Title", required: true, min: 5, max: 100, collapseSpaces: true, custom: function (v) { return /[<>]/.test(v) ? "The title cannot contain < or >." : ""; } },
      rqCategory: { label: "Category", required: true, requiredMessage: "Choose a category." },
      rqDescription: { label: "Description", required: true, min: 15, max: 1000 },
      rqPhone: { label: "Contact number", max: 13, custom: function (v) { return v && !/^03\d{9}$/.test(v.replace(/[\s-]/g, "")) ? "Enter the mobile number as 03XXXXXXXXX." : ""; } }
    }, { summary: document.getElementById("requestErr") });
    form.addEventListener("submit", submit);
  }

  async function submit(e) {
    e.preventDefault();
    const checked = rules.check();
    if (!checked.ok) return;
    const errBox = document.getElementById("requestErr");
    const payload = { title: checked.values.rqTitle, category: checked.values.rqCategory, description: checked.values.rqDescription, contactPhone: (checked.values.rqPhone || "").replace(/[\s-]/g, "") };
    const created = await CMS.busy(document.getElementById("requestSubmitBtn"), function () {
      return CMS.attempt(function () { return Api.call("POST", "/requests", payload); }, errBox);
    });
    if (!created) return;
    CMS.clearError(errBox);
    ["rqTitle", "rqDescription", "rqPhone"].forEach(function (id) { document.getElementById(id).value = ""; });
    document.getElementById("rqCategory").value = "";
    CMS.toast(created.id + " saved as " + created.status, "ok");
    state.page = 1;
    load();
  }

  function query() {
    const p = new URLSearchParams({ sort: state.sort, page: String(state.page) });
    if (state.search) p.set("search", state.search);
    if (state.category) p.set("category", state.category);
    if (state.status) p.set("status", state.status);
    return "/requests?" + p.toString();
  }

  async function load() {
    const data = await CMS.attempt(function () { return Api.call("GET", query()); });
    if (!data) return;
    state.pages = data.pages;
    if (state.page > data.pages) { state.page = data.pages; return load(); }
    document.getElementById("listCount").textContent = data.total + (data.total === 1 ? " request" : " requests") + " match";
    document.getElementById("pageInfo").textContent = "Page " + data.page + " of " + data.pages + " · " + data.pageSize + " per page";
    document.getElementById("prevPage").disabled = data.page <= 1;
    document.getElementById("nextPage").disabled = data.page >= data.pages;
    const body = document.getElementById("requestBody");
    body.replaceChildren();
    if (!data.items.length) {
      body.appendChild(h("tr", null, [h("td", { colspan: "6" }, [h("div", { class: "empty-state pad-28", text: "No requests match these filters." })])]));
      return;
    }
    data.items.forEach(function (r) {
      body.appendChild(h("tr", null, [
        h("td", null, [h("b", { text: r.title }), h("div", { class: "muted small mono", text: r.id + " · v" + r.version })]),
        h("td", { text: r.category }),
        h("td", null, [h("span", { class: "pill " + STATUS_CLASS[r.status], text: r.status })]),
        h("td", { class: "hide-sm", text: "@" + r.owner }),
        h("td", { class: "hide-sm time", text: CMS.dateTime(r.createdAt) }),
        h("td", { class: "actions" }, [h("button", { class: "btn btn-secondary btn-sm", text: "Open", "aria-label": "Open " + r.id, onclick: function () { open(r.id); } })])
      ]));
    });
  }

  async function open(id) {
    CMS.clearError(document.getElementById("detailErr"));
    const loaded = await CMS.attempt(function () { return Promise.all([Api.call("GET", "/requests/" + encodeURIComponent(id)), Api.call("GET", "/requests/" + encodeURIComponent(id) + "/history")]); });
    if (!loaded) return;
    current = loaded[0];
    renderDetail(loaded[1].history);
    CMS.openModal("requestDetail");
  }

  function renderDetail(history) {
    const r = current;
    document.getElementById("requestDetailTitle").textContent = r.id + " · " + r.title;
    document.getElementById("requestDetailSub").textContent = r.category + " · " + r.status + " · version " + r.version;
    const body = document.getElementById("requestDetailBody");
    body.replaceChildren(h("div", { class: "form-grid" }, [
      h("div", { class: "field span-2" }, [h("label", { text: "Description" }), h("p", { text: r.description })]),
      h("div", { class: "field" }, [h("label", { text: "Owner" }), h("p", { text: "@" + r.owner })]),
      h("div", { class: "field" }, [h("label", { text: "Reviewer" }), h("p", { text: r.reviewer ? "@" + r.reviewer : "Not claimed yet" })]),
      h("div", { class: "field" }, [h("label", { text: "Contact" }), h("p", { text: r.contact || "Not given" })]),
      h("div", { class: "field" }, [h("label", { text: "Status" }), h("p", null, [h("span", { class: "pill " + STATUS_CLASS[r.status], text: r.status })])]),
      r.reason ? h("div", { class: "field span-2" }, [h("label", { text: "Rejection reason" }), h("p", { text: r.reason })]) : null
    ]));
    const list = document.getElementById("historyList");
    list.replaceChildren();
    history.forEach(function (e) {
      list.appendChild(h("li", null, [
        h("b", { text: e.action }), h("span", { text: " · " + (e.from ? e.from + " → " : "") + e.to + " · v" + e.version }),
        h("div", { class: "muted small", text: "@" + e.actor + " · " + CMS.dateTime(e.at) + (e.reason ? " · " + e.reason : "") })
      ]));
    });
    const mine = r.reviewer === App.session.user;
    const canClaim = isReviewer && r.status === "Pending";
    const canFinalize = isReviewer && r.status === "In Review" && mine;
    document.getElementById("reasonField").hidden = !canFinalize;
    document.getElementById("rejectReason").value = "";
    const actions = document.getElementById("detailActions");
    actions.replaceChildren(h("button", { class: "btn btn-secondary", "data-close": "requestDetail", text: "Close", onclick: function () { CMS.closeModal("requestDetail"); } }));
    if (canClaim) actions.appendChild(h("button", { class: "btn btn-primary", text: "Claim for review", onclick: function (e) { act(e, "claim"); } }));
    if (canFinalize) {
      actions.appendChild(h("button", { class: "btn btn-danger", text: "Reject", onclick: function (e) { act(e, "reject"); } }));
      actions.appendChild(h("button", { class: "btn btn-primary", text: "Resolve", onclick: function (e) { act(e, "resolve"); } }));
    }
  }

  async function act(e, action) {
    const errBox = document.getElementById("detailErr");
    const payload = { version: current.version };
    if (action === "reject") {
      payload.reason = document.getElementById("rejectReason").value.trim();
      if (!payload.reason) { CMS.attempt(function () { const err = new Error("Give a reason for the rejection."); err.userMessage = err.message; throw err; }, errBox); return; }
    }
    const id = current.id;
    const updated = await CMS.busy(e.currentTarget, function () {
      return Api.call("POST", "/requests/" + encodeURIComponent(id) + "/" + action, payload).catch(function (error) { return { failed: error }; });
    });
    if (updated && updated.failed) {
      CMS.attempt(function () { throw updated.failed; }, errBox);
      // Someone else changed it first: show what is now saved, so nothing is overwritten by mistake
      if (updated.failed.status === 409) { load(); setTimeout(function () { refreshDetail(id); }, 0); }
      return;
    }
    CMS.clearError(errBox);
    CMS.toast(id + " is now " + updated.status, "ok");
    load();
    refreshDetail(id);
  }

  async function refreshDetail(id) {
    const loaded = await Promise.all([Api.call("GET", "/requests/" + encodeURIComponent(id)), Api.call("GET", "/requests/" + encodeURIComponent(id) + "/history")]).catch(function () { return null; });
    if (!loaded) { CMS.closeModal("requestDetail"); return; }
    current = loaded[0];
    renderDetail(loaded[1].history);
  }
})();
