// Plays the sample feed: caught posts glow gold, show which filter caught
// them, then fold away.
(() => {
  const posts = [...document.querySelectorAll(".post[data-caught]")];
  const tally = document.getElementById("tally");
  const noun = document.getElementById("tally-noun");
  const replay = document.getElementById("replay");
  const feed = document.getElementById("feed");
  if (!posts.length || !tally || !feed) return;
  let timers = [];

  function reset() {
    timers.forEach(clearTimeout);
    timers = [];
    posts.forEach((p) => p.classList.remove("marked", "gone"));
    count(0);
  }

  function count(n) {
    tally.textContent = String(n);
    if (noun) noun.textContent = n === 1 ? "post" : "posts";
  }

  function play() {
    reset();
    posts.forEach((p, i) => {
      const at = 700 + i * 900;
      timers.push(setTimeout(() => p.classList.add("marked"), at));
      timers.push(setTimeout(() => {
        p.classList.add("gone");
        count(i + 1);
      }, at + 1500));
    });
  }

  // It plays once the feed has stayed in view for a moment, so scrolling
  // past it, as the Install link does, doesn't start it. Its posts fold away
  // as it plays, which would move the page under that scroll.
  let soon = null;
  const seen = new IntersectionObserver((entries) => {
    const visible = entries.some((e) => e.isIntersecting);
    clearTimeout(soon);
    if (!visible) return;
    soon = setTimeout(() => {
      seen.disconnect();
      play();
    }, 400);
  }, { threshold: 0.45 });
  seen.observe(feed);
  replay?.addEventListener("click", play);
})();
