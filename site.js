// Sections drift up into place as they scroll into view.
(() => {
  const items = document.querySelectorAll(".reveal");
  if (!("IntersectionObserver" in window)) {
    items.forEach((el) => el.classList.add("shown"));
    return;
  }
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("shown");
      seen.unobserve(e.target);
    }
  }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
  items.forEach((el) => seen.observe(el));
})();

// In-page links land on their section even when the page above it changes
// height during the scroll, as the sample feed does when it folds away its
// caught posts. Once the scroll ends, it is corrected if it fell short.
(() => {
  document.addEventListener("click", (event) => {
    const link = event.target.closest('a[href^="#"]');
    const id = link && link.getAttribute("href").slice(1);
    const target = id && document.getElementById(id);
    if (!target) return;
    let tries = 2;
    const settle = () => {
      const pad = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
      const off = target.getBoundingClientRect().top - pad;
      const room = document.documentElement.scrollHeight - innerHeight - scrollY;
      if (Math.abs(off) < 3 || (off > 0 && room < 3) || tries-- <= 0) return;
      target.scrollIntoView({ behavior: "smooth" });
      wait();
    };
    const wait = () => {
      if ("onscrollend" in window) addEventListener("scrollend", settle, { once: true });
      else setTimeout(settle, 900);
    };
    wait();
  });
})();
