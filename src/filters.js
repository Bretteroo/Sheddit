// SPDX-License-Identifier: AGPL-3.0-only
// Sheddit filter definitions, shared by the content script and settings page.
//
// To add a filter, append an entry. `test(text, parts)` returns true if the
// post should be hidden. `text` is everything being checked: the thread title
// on listing pages, or the title plus the post body on a thread page. `parts`
// holds:
//   title    the post title
//   body     the post body on thread pages, with a blank line between
//            paragraphs; empty on listing pages
//   domain   the site a link post points to, like "youtube.com"; empty or
//            a reddit.com address for text posts
//   embeds   domains of media embedded in the post and of links in its body
//   hasText  whether the post has any body text, as far as the page shows,
//            not counting bare web addresses
//
// Every filter checks posts and, on thread pages, comments too. For a comment,
// `text` and `body` are the comment's own text (not its replies) and `title`
// is empty.

// Firefox exposes the extension API as `browser`, Chrome as `chrome`. Both
// return promises from storage calls in Manifest V3.
const shedditApi = typeof browser !== "undefined" ? browser : chrome;

const SHEDDIT_FILTERS = [
  {
    id: "curiosity-killer",
    title: "Curiosity Killer",
    description: 'Hides posts and comments containing "genuinely curious", or "Curious." as a sentence on its own.',
    enabledByDefault: true,
    // "Curious." counts at the start of the text or right after another
    // sentence, so "Just curious." on its own does not.
    test: (text) =>
      /genuinely\s+curious/i.test(text) || /(^|[.!?]\s+|\n\s*)curious\./i.test(text.trim()),
  },
  {
    id: "shock-absorber",
    title: "Shock Absorber",
    description: 'Hides posts and comments containing the phrase "what surprised me the most".',
    enabledByDefault: true,
    test: (text) => /what\s+surprised\s+me\s+the\s+most/i.test(text),
  },
  {
    id: "storm-shelter",
    title: "Storm Shelter",
    description: 'Hides posts and comments containing the phrase "blown away".',
    enabledByDefault: true,
    test: (text) => /blown\s+away/i.test(text),
  },
  {
    id: "sarcasm-sweeper",
    title: "Sarcasm Sweeper",
    description: 'Hides posts and comments containing the "/s" sarcasm tag.',
    enabledByDefault: true,
    // "/s" standing alone, so "r/sports" and links like "example.com/s/x"
    // do not count.
    test: (text) => /(^|[\s([{"'.,!?;:])\/s(?=$|[\s)\]}"'.,!?;:])/i.test(text),
  },
  {
    id: "wrecking-ball",
    title: "Wrecking Ball",
    description: "Hides long posts and comments written as one giant paragraph.",
    enabledByDefault: true,
    // Only open threads have a body to check. "Long" means at least 1,000
    // characters, roughly 170 words.
    test: (text, { body }) => {
      const trimmed = body.trim();
      return trimmed.length >= 1000 && !/\n\s*\n/.test(trimmed);
    },
  },
  {
    id: "get-a-blog",
    title: "Christ, get a blog",
    description: "Hides posts and comments longer than 600 words, about a three-minute read.",
    enabledByDefault: true,
    // Only open threads have a body to check. A word is a run of
    // non-space characters with at least one letter or digit in it, so
    // bullets, dashes, and emoji don't add to the count.
    test: (text, { body }) => (body.match(/\S*[\p{L}\p{N}]\S*/gu) || []).length >= 600,
  },
  {
    id: "pearl-clutcher",
    title: "Hyperbolic Chamber",
    description: 'Hides posts and comments containing "witaf" or "what in the actual fuck".',
    enabledByDefault: true,
    test: (text) => /\bwitaf\b|what\s+in\s+the\s+actual\s+fuck/i.test(text),
  },
  {
    id: "candor-cutter",
    title: "Candor Cutter",
    description: 'Hides posts and comments containing "and honestly?"',
    enabledByDefault: true,
    test: (text) => /\band\s+honestly\s*\?/i.test(text),
  },
  {
    id: "bingo-blackout",
    title: "Bingo Blackout",
    description: 'Hides posts and comments containing "not on my bingo card".',
    enabledByDefault: true,
    // Also "wasn't on my bingo card" and up to two words before "bingo",
    // as in "not on my 2026 bingo card".
    test: (text) =>
      /(\bnot|n['\u2019]t)\s+on\s+my\s+(\S+\s+){0,2}bingo\s+cards?\b/i.test(text),
  },
  {
    id: "year-end-clearance",
    title: "Year-End Clearance",
    description: 'Hides posts whose title ends in a year, like "Best TV to buy in 2026?"',
    enabledByDefault: true,
    // Only years from last year to two years ahead count, so historical
    // titles like "My grandfather's farm in 1944" are left alone. Trailing
    // punctuation, closing brackets, and quotes after the year are ignored.
    // A year that is part of a date ("November 04, 2026", "4 Nov 2026",
    // "11/04/2026", "November 2026") marks a dated thread, not a question,
    // so it doesn't count.
    test: (text, { title }) => {
      const m = title.trim().match(/\b(\d{4})[\s?!.)\]"'\u201d\u2019]*$/);
      if (!m) return false;
      const before = title.trim().slice(0, m.index);
      const month = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b\\.?";
      const dated = new RegExp(
        `(?:\\b${month}\\s+(?:\\d{1,2}(?:st|nd|rd|th)?,?\\s+)?|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${month},?\\s+|\\b\\d{1,2}[/.-]\\d{1,2}[/.-])$`,
        "i");
      if (dated.test(before)) return false;
      const year = Number(m[1]);
      const now = new Date().getFullYear();
      return year >= now - 1 && year <= now + 2;
    },
  },
  {
    id: "inside-voice",
    title: "Inside Voice",
    description: "Hides posts whose title is written in ALL CAPS.",
    enabledByDefault: true,
    // At least 8 capital letters and no lowercase ones, so short acronym
    // titles like "AITA" or "PSA" are left alone.
    test: (text, { title }) =>
      (title.match(/\p{Lu}/gu) || []).length >= 8 && !/\p{Ll}/u.test(title),
  },
  {
    id: "catch-and-release",
    title: "Catch and Release",
    description: "Hides engagement bait: long posts and comments that end in a question.",
    enabledByDefault: true,
    // Only open threads have a body to check. "Long" uses the same 1,000
    // character line as Wrecking Ball. Closing brackets, quotes, and spaces
    // after the final question mark are ignored.
    test: (text, { body }) => {
      const trimmed = body.replace(/[\s)\]"'\u201d\u2019]+$/, "");
      return trimmed.length >= 1000 && trimmed.endsWith("?");
    },
  },
  {
    id: "skip-ad",
    title: "Skip Ad",
    description: "Hides posts that are just a YouTube link or embedded YouTube video with no text.",
    enabledByDefault: true,
    // A post with no body text (bare links don't count as text) that links
    // to or embeds youtube.com (any subdomain, like m. or music.), the
    // youtu.be short-link domain, or youtube-nocookie.com, which YouTube
    // uses for privacy-mode embeds.
    test: (text, { domain, embeds = [], hasText }) =>
      !hasText &&
      [domain, ...embeds].some((d) =>
        /(^|\.)youtube\.com$|^youtu\.be$|(^|\.)youtube-nocookie\.com$/.test(d || "")),
  },
  {
    id: "small-talk",
    title: "Small Talk",
    description: "Hides posts and comments written without a single capital letter, except Reddit's [deleted] and [removed].",
    enabledByDefault: true,
    // Needs at least one lowercase letter, so titles made of numbers, emoji,
    // or scripts without capitals (Chinese, Japanese, Arabic...) are left
    // alone, and so are Reddit's "[deleted]" and "[removed]" placeholders.
    test: (text) =>
      /\p{Ll}/u.test(text) &&
      !/\p{Lu}/u.test(text) &&
      !/^\[(deleted|removed)\]$/.test(text.trim()),
  },
  {
    id: "pity-party",
    title: "Pity Party",
    description: 'Hides posts and comments saying "I don\'t know why you\'re getting downvoted".',
    enabledByDefault: true,
    // Also "being downvoted", "idk why", and missing apostrophes.
    test: (text) =>
      /\b(?:(?:don['\u2019]?t|do\s+not)\s+know|idk)\s+why\s+(?:you['\u2019]?re|you\s+are|ur)\s+(?:getting|being)\s+downvoted/i.test(text),
  },
  {
    id: "trade-secret",
    title: "Trade Secret",
    description: 'Hides posts and comments where someone is an electrician, engineer, or anything else "by trade".',
    enabledByDefault: true,
    // Economics uses the same words ("driven by trade", "by trade
    // agreements"), so "by trade" doesn't count after a verb like "driven"
    // or "affected", or before a word like "war" or "deal".
    test: (text) =>
      /(?<!\b(?:driven|affected|impacted|hit|caused|dominated|limited|restricted|influenced|fu?el+ed|boosted|hurt|harmed|supported|financed|funded|enriched|connected|linked|shaped|generated|earned|made|measured|ranked|disrupted|threatened|damaged|weakened|strengthened|helped)\s+)\bby\s+trade\b(?!\s*-?\s*(?:wars?|agreements?|deals?|polic(?:y|ies)|tariffs?|deficits?|surplus(?:es)?|barriers?|routes?|unions?|secrets?|schools?|shows?|names?|marks?|disputes?|sanctions?|restrictions?|volumes?|partners?|balances?|imbalances?|negotiations?|tensions?|talks|embargo(?:es)?|blocs?|flows?|policies|relations|ties|liberali[sz]ation|openness|exposure|and\s+investment|and\s+tariffs|or\s+investment)\b)/i.test(text),
  },
  {
    id: "pitchfork-patrol",
    title: "Pitchfork Patrol",
    description: 'Hides posts and comments that scold companies, like "not a good look" or "do better".',
    enabledByDefault: true,
    test: (text) => PITCHFORK_PHRASES.some((re) => re.test(text)),
  },
  {
    id: "case-dismissed",
    title: "Case Dismissed",
    description: 'Hides armchair-lawyer posts and comments like "Class action lawsuit, anyone?" or "I smell a class action".',
    enabledByDefault: true,
    test: (text) => LAWYER_PHRASES.some((re) => re.test(text)),
  },
  {
    id: "sinkhole",
    title: "Sinkhole",
    description: 'Hides posts and comments containing "let that sink in".',
    enabledByDefault: true,
    // Also "let this sink in" and one word in between, like "let that one
    // sink in" or "let that number sink in".
    test: (text) => /\blet\s+(?:that|this)\s+(?:\w+\s+)?sink\s+in\b/i.test(text),
  },
  {
    id: "lie-detector",
    title: "Lie Detector",
    description: 'Hides posts and comments containing "honest review".',
    enabledByDefault: true,
    // Also "honest reviews", "brutally honest review" and "100% honest
    // review", but not "dishonest review".
    test: (text) => /(?<![\w-])honest\s+reviews?\b/i.test(text),
  },
  {
    id: "teachable-moment",
    title: "Teachable Moment",
    description: 'Hides "I did X. Here\'s what I learned" posts and comments, and titles like "What I learned about X".',
    enabledByDefault: true,
    test: (text) => LESSON_PHRASES.some((re) => re.test(text)),
  },
  {
    id: "your-welcome",
    title: "Your Welcome",
    description: 'Hides posts and comments that use "your" where they mean "you\'re", like "your welcome" or "your the best".',
    enabledByDefault: true,
    test: (text) => YOURE_PHRASES.some((re) => re.test(text)),
  },
];

// Phrases for Your Welcome. "Your" followed by almost any word can be
// right ("your cooking", "your right to vote"), so these only cover the
// combinations that are nearly always a "you're" in disguise.
const CLAUSE_END = String.raw`(?=\s*(?:[.!?,;:)]|$|lol\b|lmao\b|haha\b))`;
const YOURE_PHRASES = [
  // "Your welcome", "Your wrong.", "your right lol" (but not "your welcome
  // message", "your right to vote", "that's your right." or "you
  // overstayed your welcome.")
  new RegExp(String.raw`(?<!\b(?:is|was|be|been|(?:is|was|isn['\u2019]?t|wasn['\u2019]?t)\s+that|it['\u2019]?s|that['\u2019]?s|its|within|exercise[sd]?|exercising|overstay(?:s|ed|ing)?|outstay(?:s|ed|ing)?|for|of|on)\s+)\byour\s+(?:welcome|wrong|right)${CLAUSE_END}`, "im"),
  // "your not", "your never", "your gonna", "your going to" (but not
  // "your never-ending list")
  /\byour\s+(?:not|never|gonna|going\s+to)\b(?!-)/i,
  // "your a genius", "your an idiot", "your the best" (lowercase, so "bring
  // your A game" and "your The Office DVD" don't count)
  /\b[Yy]our\s+(?:a|an|the)\s+(?!game\b)[a-z]/,
  // "your so dumb.", "your too kind!" (but not "your very own car")
  new RegExp(String.raw`\byour\s+(?:so|too|very|really)\s+[a-z]+${CLAUSE_END}`, "im"),
  // "if your being serious", "because your trying too hard" (but not "if
  // your doing so is legal")
  /\b(?:if|when|because|cause|cuz|since|unless|until|while)\s+your\s+(?:being|doing(?!\s+so\b)|trying|getting|saying|talking|making|acting)\b/i,
];

// Phrases for Teachable Moment. "Learned" or "learnt", with or without
// "I've".
const LEARNED = String.raw`I(?:['\u2019]?ve|\s+have)?\s+learn(?:ed|t)`;
const LESSON_PHRASES = [
  // "Here's what I learned", "Here is what I've learnt"
  new RegExp(String.raw`\bhere(?:['\u2019]?s|\s+is)\s+what\s+${LEARNED}\b`, "i"),
  // "What I learned about X", "What I learned from X", "What I learned
  // after...", or "What I learned." on its own, at the start of a title or
  // sentence or after a colon or dash. "What I learned is that..." in the
  // middle of a conversation doesn't count.
  new RegExp(String.raw`(?:^|[.!?:;|\u2013\u2014-]\s*|\n\s*)what\s+${LEARNED}(?:\s+(?:about|from|after|while|when|building|running|making|doing|using|trying|selling|launching|quitting|spending|working)\b|\s*(?:[.!?:)]|$))`, "im"),
];

// Phrases for Pitchfork Patrol. Add more here; each is a case-insensitive
// regular expression.
const PITCHFORK_PHRASES = [
  /\bnot\s+a\s+(?:good|great)\s+look\b/i,
  /\b(?:such\s+a|really\s+a|a\s+really|a\s+very|very)\s+bad\s+look\b/i,
  /\bbad\s+look\s+for\b/i,
  // "Do better." / "Be better" as a demand: it has to start a sentence or
  // follow a comma, dash, "just", "please", or "need to", "has to", "must"
  // or "should" (but not "I need to" or "we must"), and end a sentence or
  // clause. So "Nintendo, do better." and "You need to do better." count,
  // but "the other side can do better." and "How can I do better?" don't.
  /(?:^|[.!?,;:(\u2013\u2014-]\s*|\b(?:just|please)\s+|(?<!\b(?:I|we)\s+)\b(?:needs?\s+to|ha(?:ve|s)\s+to|gotta|must|should)\s+)(?:do|be)\s+better\b(?=\s*(?:[.!,;)]|$))/im,
  /\bthis\s+ain'?t\s+it\b/i,
];

// Phrases for Case Dismissed. LAWSUIT matches "class action", "class
// action lawsuit", "class-action suit" or "lawsuit". Plain mentions of a
// real case ("the class action settled last year") don't match; only the
// gleeful calls for one do.
const LAWSUIT = String.raw`(?:class[\s-]+action(?:\s+(?:law)?suits?)?|lawsuits?)`;
const LAWYER_PHRASES = [
  // "Class action lawsuit, anyone?"
  new RegExp(String.raw`\b${LAWSUIT}\s*[,.]*\s*(?:anyone|anybody)\s*\?`, "i"),
  // "I smell a class action", "Do I smell a lawsuit?"
  new RegExp(String.raw`\bsmell\s+(?:a\s+|an?\s+\S+\s+)?${LAWSUIT}`, "i"),
  // "Sounds like a class action to me"
  new RegExp(String.raw`\b(?:sounds|smells|looks|feels)\s+like\s+(?:a\s+)?${LAWSUIT}`, "i"),
  // "Class action incoming", "Lawsuit waiting to happen", "Lawsuit in 3, 2, 1"
  new RegExp(String.raw`\b${LAWSUIT}\s+(?:incoming|waiting\s+to\s+happen|in\s+3)`, "i"),
  // "Time for a class action", "Somebody start a class action"
  new RegExp(String.raw`\b(?:time\s+for|start|file|ripe\s+for|grounds\s+for)\s+(?:a\s+)?class[\s-]+action`, "i"),
];

// Settings are stored as { enabled: { [filterId]: boolean } }. Filters with
// no saved value fall back to enabledByDefault.
async function shedditLoadEnabled() {
  const { enabled = {} } = await shedditApi.storage.sync.get("enabled");
  const result = {};
  for (const f of SHEDDIT_FILTERS) {
    result[f.id] = f.id in enabled ? enabled[f.id] : f.enabledByDefault;
  }
  return result;
}

// What happens to a matching post: "hide" removes it from the page, "veil"
// leaves it in place under an overlay with a button to reveal it.
async function shedditLoadMode() {
  const { mode } = await shedditApi.storage.sync.get("mode");
  return mode === "veil" ? "veil" : "hide";
}
