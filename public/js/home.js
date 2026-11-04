(function () {
  var body = document.body;
  var toggle = document.getElementById("themeToggle");
  var storageKey = "cms_theme";
  var saved = null;

  try { saved = localStorage.getItem(storageKey); } catch (e) {}
  if (saved === "night") applyTheme("night");

  function applyTheme(theme) {
    var night = theme === "night";
    body.setAttribute("data-theme", night ? "night" : "light");
    if (toggle) {
      toggle.setAttribute("aria-pressed", String(night));
      toggle.setAttribute("aria-label", night ? "Switch to light mode" : "Switch to night cafe mode");
      var label = toggle.querySelector("span");
      if (label) label.textContent = night ? "Day mode" : "Night mode";
    }
    try { localStorage.setItem(storageKey, night ? "night" : "light"); } catch (e) {}
  }

  if (toggle) toggle.addEventListener("click", function () {
    applyTheme(body.getAttribute("data-theme") === "night" ? "light" : "night");
  });

  function updateNav() { body.classList.toggle("nav-scrolled", window.scrollY > 18); }
  updateNav();
  window.addEventListener("scroll", updateNav, { passive: true });

  var revealItems = document.querySelectorAll("[data-reveal]");
  if ("IntersectionObserver" in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { entry.target.classList.add("reveal-visible"); observer.unobserve(entry.target); }
      });
    }, { threshold: .12 });
    revealItems.forEach(function (item) { observer.observe(item); });
  } else revealItems.forEach(function (item) { item.classList.add("reveal-visible"); });

  var stage = document.querySelector(".hero-stage");
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (stage && !reduce) window.addEventListener("scroll", function () {
    var offset = Math.min(24, window.scrollY * .08);
    stage.style.transform = "translateY(" + offset + "px)";
  }, { passive: true });

  var reviews = [
    { quote: "The waiter knows what is ready, the kitchen knows what is next, and the manager finally sees the whole day.", author: "Sara Khan · Manager workspace" },
    { quote: "Taking an order feels as quick as serving a coffee. No paper, no guessing, no duplicate work.", author: "M. Usman · Waiter workspace" },
    { quote: "Every important change has a clear trail. That is the kind of calm a busy cafe needs.", author: "Farah Siddiqui · Admin workspace" }
  ];
  var reviewCard = document.getElementById("reviewCard");
  var reviewIndex = 0;
  function showReview(index) {
    if (!reviewCard) return;
    reviewIndex = (index + reviews.length) % reviews.length;
    reviewCard.querySelector("blockquote").textContent = "“" + reviews[reviewIndex].quote + "”";
    reviewCard.querySelector(".review-author").textContent = reviews[reviewIndex].author;
  }
  showReview(0);
  var previous = document.getElementById("reviewPrev");
  var next = document.getElementById("reviewNext");
  if (previous) previous.addEventListener("click", function () { showReview(reviewIndex - 1); });
  if (next) next.addEventListener("click", function () { showReview(reviewIndex + 1); });
})();
