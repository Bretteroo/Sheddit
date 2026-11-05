<p align="center">
  <img src="sheddit-transparent.png" alt="Sheddit logo" width="70%">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0--only-1e5aa8?style=flat-square" alt="License: AGPL-3.0-only"></a>
  <img src="https://img.shields.io/badge/manifest-V3-orange?style=flat-square" alt="Manifest V3">
  <img src="https://img.shields.io/badge/browsers-Firefox%20%7C%20Chrome%20%7C%20Edge%20%7C%20Opera-gold?style=flat-square" alt="Works in Firefox, Chrome, Edge and Opera">
</p>

<div align="center">


---

_The path to enlightenment is lined with hidden posts._

[🔭 How it sees](#-how-it-sees) | [🪷 Filters](#-filters) | [🍃 Letting go](#-letting-go) | [📦 Install](#-install) | [🔒 License](#-license)

</div>

---



# Sheddit

Sheddit is a Firefox and Chrome extension that hides Reddit’s most repetitive and obnoxious posting habits, helping you scroll your way toward enlightenment.

Sheddit helps you cast off the negative parts of the Reddit experience, lightening your mental load as they fall away one repetitive trope at a time, so that your mind may rest on the conversations worth having.  If you've read the phrase "genuinely curious" one too many times, Sheddit is a beacon of hope and a path to a more peaceful Reddit experience.

## 🔭 How it sees

Sheddit dwells only in the present page.

- On a **listing**: it contemplates each thread's title.
- On an **open thread** it contemplates the post's title, body, and the comments beneath it.

Filters then hide or block negative energy contained therein, defined by your filter-based, values-driven ruleset.

Sheddit walks the path on www.reddit.com, old.reddit.com and Reddit's mobile layout. Your choices rest in your browser's sync storage, and nothing you read is sent anywhere. Enlightenment comes from within...and stays local.

## 🪷 Filters

| Filter | What it hides | Default |
| --- | --- | --- |
| Curiosity Killer | Posts and comments containing "genuinely curious", or "Curious." as a sentence on its own | On |
| Shock Absorber | Posts and comments containing "what surprised me the most" | On |
| Storm Shelter | Posts and comments containing "blown away" | On |
| Sarcasm Sweeper | Posts and comments containing the "/s" sarcasm tag | On |
| Wrecking Ball | Open threads and comments of 1,000+ characters in one paragraph | On |
| Hyperbolic Chamber | Posts and comments containing "witaf" or "what in the actual fuck" | On |
| Candor Cutter | Posts and comments containing "and honestly?" | On |
| Bingo Blackout | Posts and comments containing "not on my bingo card" | On |
| Year-End Clearance | Posts whose title ends in a year, from last year to two years ahead | On |
| Inside Voice | Posts whose title is in ALL CAPS (8+ capital letters, no lowercase) | On |
| Small Talk | Posts and comments written without a single capital letter | On |
| Catch and Release | Open threads and comments of 1,000+ characters that end in a question | On |
| Skip Ad | Posts that are just a YouTube link or embedded YouTube video with no text | On |
| Pity Party | Posts and comments saying "I don't know why you're getting downvoted" | On |
| Trade Secret | Posts and comments where someone is something "by trade" | On |
| Pitchfork Patrol | Posts and comments that scold companies: "not a good look", "bad look", "this ain't it", or "do better" as a demand | On |
| Case Dismissed | Armchair-lawyer posts and comments like "Class action lawsuit, anyone?" or "I smell a class action" | On |
| Sinkhole | Posts and comments containing "let that sink in" | On |

Each filter may be taken up or set aside from the settings page (see Install below), and your open Reddit tabs feel the change at once. There is no wrong way to shed, only fewer posts begging for someone to start a class action lawsuit.

## 🍃 Letting go

When a post or comment is found wanting, Sheddit offers two paths, chosen on its Settings page:

- **Remove it**. It passes from the page entirely, and you continue as though it had never been. This is the way of non-attachment.  And the default behavior. If you open a thread whose post was caught, it waits for you behind the veil, so you aren't greeted by an empty page.
- **Cover it**. It rests beneath a slim gold veil bearing the name of the filter that caught it. You may peek upon the transgression, should temptation arise, and Hide again returns it to the veil.

Sheddit's toolbar button records your progress on the current tab: how many posts and comments you have risen above, and which filters guided you. It also keeps a modest journal of your ascension over the last 24 hours, 7 days and 30 days, stored only in your browser, and shows the way to the settings.

## 📦 Install

Download the file for your browser from the [latest release](https://github.com/Bretteroo/Sheddit/releases/latest), then follow the steps for your browser below.

<details>
<summary>Firefox</summary>

1. Download `sheddit-<version>-firefox.xpi`.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click "Load Temporary Add-on..." and pick the `.xpi`.

The `.xpi` isn't signed by Mozilla yet, so Firefox removes it when it
restarts. Firefox Developer Edition and Nightly can keep it installed with
`xpinstall.signatures.required` set to false in `about:config`.

Filter settings are under `about:addons`, Sheddit, Preferences.

</details>

<details>
<summary>Chrome</summary>

1. Download `sheddit-<version>-chrome.zip` and unzip it.
2. Open `chrome://extensions` and turn on "Developer mode" (top right).
3. Click "Load unpacked" and pick the unzipped folder.

Unpacked extensions stay installed across restarts. Filter settings are
under `chrome://extensions`, Sheddit, Details, "Extension options".

</details>

<details>
<summary>Edge</summary>

1. Download `sheddit-<version>-chrome.zip` and unzip it.
2. Open `edge://extensions` and turn on "Developer mode" (left sidebar).
3. Click "Load unpacked" and pick the unzipped folder.

</details>

<details>
<summary>Opera</summary>

1. Download `sheddit-<version>-chrome.zip` and unzip it.
2. Open `opera://extensions` and turn on "Developer mode" (top right).
3. Click "Load unpacked" and pick the unzipped folder.

</details>

<details>
<summary>Brave and Vivaldi</summary>

1. Download `sheddit-<version>-chrome.zip` and unzip it.
2. Open `brave://extensions` or `vivaldi:extensions` and turn on
   "Developer mode".
3. Click "Load unpacked" and pick the unzipped folder.

</details>

## 🔒 License

Sheddit is free software, licensed under the [GNU Affero General Public License, version 3 only](LICENSE) (AGPL-3.0-only).
