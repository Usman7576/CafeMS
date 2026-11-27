// Landing page touches: a border under the navigation once the page scrolls, and sections that fade
// up as they come into view. Nothing moves when the device asks for reduced motion.
(function () {
  const nav = document.getElementById("siteNav");
  function onScroll() { if (nav) nav.classList.toggle("scrolled", window.scrollY > 10); }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;
  document.documentElement.classList.add("reveal-on");
  const seen = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) { e.target.classList.add("in"); seen.unobserve(e.target); }
    });
  }, { threshold: 0.1, rootMargin: "0px 0px -40px 0px" });
  document.querySelectorAll(".reveal").forEach(function (node) { seen.observe(node); });
})();
