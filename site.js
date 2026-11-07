// Opens and closes the install expanders with a slide, instead of the
// browser's instant jump.
(() => {
  const still = matchMedia("(prefers-reduced-motion: reduce)");
  for (const details of document.querySelectorAll("details")) {
    const summary = details.querySelector("summary");
    const more = details.querySelector(".more");
    if (!summary || !more) continue;
    let running = null;
    if (details.open) details.classList.add("is-open");

    summary.addEventListener("click", (event) => {
      event.preventDefault();
      const opening = !details.classList.contains("is-open");
      details.classList.toggle("is-open", opening);
      const from = running ? more.getBoundingClientRect().height : (opening ? 0 : more.scrollHeight);
      running?.cancel();
      if (opening) details.open = true;
      const to = opening ? more.scrollHeight : 0;
      if (still.matches) {
        details.open = opening;
        running = null;
        return;
      }
      running = more.animate(
        [{ height: `${from}px`, opacity: opening ? 0 : 1 }, { height: `${to}px`, opacity: opening ? 1 : 0 }],
        { duration: 320, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)" },
      );
      running.onfinish = () => {
        running = null;
        if (!opening) details.open = false;
      };
    });
  }
})();

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
