// Loaded in each page's <head>, before anything is drawn: applies the chosen theme (System, Light or
// Dark, remembered on this device only) so the page never flashes the wrong colours, and registers the
// service worker that makes CafeMS installable.
(function () {
  const KEY = "cms-theme";
  function stored() {
    try { return localStorage.getItem(KEY) || "system"; } catch (e) { return "system"; }
  }
  function apply(choice) {
    if (choice === "light" || choice === "dark") document.documentElement.setAttribute("data-theme", choice);
    else document.documentElement.removeAttribute("data-theme");
  }
  apply(stored());

  window.Theme = {
    get: stored,
    set: function (choice) {
      try { localStorage.setItem(KEY, choice); } catch (e) { /* private window: the choice lasts this visit only */ }
      apply(choice);
    }
  };

  // The page forbids building script addresses from plain strings (Trusted Types), so a policy that
  // allows exactly one address, the service worker, is created for it
  if ("serviceWorker" in navigator && window.isSecureContext) {
    let url = "/sw.js";
    if (window.trustedTypes && window.trustedTypes.createPolicy) {
      const policy = window.trustedTypes.createPolicy("cafems-sw", { createScriptURL: function (u) { if (u !== "/sw.js") throw new TypeError("Blocked script URL"); return u; } });
      url = policy.createScriptURL("/sw.js");
    }
    window.addEventListener("load", function () { navigator.serviceWorker.register(url, { scope: "/" }).catch(function () { /* the app still works without it */ }); });
  }
})();
