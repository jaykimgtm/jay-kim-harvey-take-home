// Web editor for the slide site, loaded on demand (press E, or open the page with ?edit).
// Edits text in place; moves, resizes, restyles, duplicates and deletes blocks; inserts text, headings, lists and
// images; adds, copies, reorders and deletes slides; edits tab labels, tones and speaker notes; undo.
// Save writes deck.html (and any new images under assets/) to the public Pages repo through the GitHub API.
//
// The GitHub token is never in the page in clear. The site owner creates a fine-grained token once (this repo
// only, Contents read and write, with an expiry) and the setup step encrypts it with the save code
// (PBKDF2-SHA256 + AES-GCM) into editor.json in the repo. A short numeric save code can be found by anyone who
// reads that file and tries every value, so the token must stay scoped to this one repo and expire.
(() => {
  const REPO = "jaykimgtm/jay-kim-harvey-take-home";
  const API = `https://api.github.com/repos/${REPO}/contents/`;
  const RAW = `https://raw.githubusercontent.com/${REPO}/main/`;
  const AUTHOR = { name: "Jay Kim", email: "18307727+jaykimgtm@users.noreply.github.com" };
  const KDF_ITERATIONS = 1200000;
  const TOKEN_HELP =
    "https://github.com/settings/personal-access-tokens/new";

  const html = document.documentElement;
  const D = window.Deck;
  const deck = D.deck;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  let token = null; // decrypted GitHub token, kept in memory for this visit only
  let selected = null;
  let undoStack = [];
  let typingSnapshot = false;
  let dirty = false;
  let ui = null;
  let loop = 0;

  // ------------------------------------------------------------------ small helpers
  const $ = (sel, root = document) => root.querySelector(sel);
  const h = (tag, attrs = {}, kids = []) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "text") el.textContent = v;
      else if (k === "html") el.innerHTML = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
    }
    (Array.isArray(kids) ? kids : [kids]).forEach((c) => c && el.append(c));
    return el;
  };
  const b64 = (bytes) => {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
  const normCode = (s) => s.normalize("NFKC").trim();
  async function sha256hex(text) {
    const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  // ------------------------------------------------------------------ token sealing
  async function deriveKey(code, salt, iterations) {
    const base = await crypto.subtle.importKey("raw", enc.encode(code), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }
  async function sealToken(code, secret) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(code, salt, KDF_ITERATIONS);
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(secret)));
    return { v: 1, kdf: "PBKDF2-SHA256", iterations: KDF_ITERATIONS, salt: b64(salt), iv: b64(iv), data: b64(data) };
  }
  async function openToken(code, blob) {
    const key = await deriveKey(code, unb64(blob.salt), blob.iterations);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(blob.iv) }, key, unb64(blob.data));
    return dec.decode(plain);
  }
  async function loadSealedToken() {
    for (const url of [`editor.json?t=${Date.now()}`, `${RAW}editor.json?t=${Date.now()}`]) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (res.ok) {
          const blob = await res.json();
          if (blob && blob.data && blob.salt && blob.iv) return blob;
        }
      } catch (err) {
        /* try the next place */
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ GitHub
  async function gh(path, opts = {}, tok = token) {
    return fetch(API + path, {
      ...opts,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${tok}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(opts.headers || {}),
      },
    });
  }
  async function getSha(path, tok = token) {
    const res = await gh(`${path}?ref=main&t=${Date.now()}`, {}, tok);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    return (await res.json()).sha;
  }
  async function putFile(path, base64, message, tok = token) {
    const sha = await getSha(path, tok);
    const body = { message, content: base64, branch: "main", committer: AUTHOR, author: AUTHOR };
    if (sha) body.sha = sha;
    const res = await gh(path, { method: "PUT", body: JSON.stringify(body) }, tok);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`GitHub answered ${res.status}${err.message ? `: ${err.message}` : ""}`);
    }
    return res.json();
  }

  // ------------------------------------------------------------------ unlock / setup dialog
  function unlockDialog() {
    return new Promise(async (resolve) => {
      const sealed = await loadSealedToken();
      const err = h("p", { class: "ed-modal__err", role: "alert" });
      const code = h("input", { class: "ed-input", type: "password", inputmode: "numeric", autocomplete: "off", "aria-label": "Save code" });
      const tokenField = h("input", { class: "ed-input", type: "password", autocomplete: "off", spellcheck: "false", "aria-label": "GitHub token" });
      const submit = h("button", { class: "ed-btn ed-btn--solid", type: "submit", text: sealed ? "Unlock editor" : "Set up and edit" });
      const local = h("button", { class: "ed-btn", type: "button", text: "Edit without saving" });
      const cancel = h("button", { class: "ed-btn ed-btn--ghost", type: "button", text: "Cancel" });
      const body = sealed
        ? [
            h("p", { class: "ed-modal__lead", text: "Enter the save code to edit and publish these slides." }),
            h("label", { class: "ed-label", text: "Save code" }),
            code,
          ]
        : [
            h("p", {
              class: "ed-modal__lead",
              html:
                "First-time setup. Create a fine-grained GitHub token: <em>Only select repositories</em> → " +
                "<strong>jay-kim-harvey-take-home</strong>; <em>Repository permissions</em> → <strong>Contents: Read and write</strong>; " +
                `an expiry after your interview. <a href="${TOKEN_HELP}" target="_blank" rel="noopener">Open GitHub</a>. ` +
                "The token is encrypted with your save code before it leaves this page.",
            }),
            h("label", { class: "ed-label", text: "Choose the save code" }),
            code,
            h("label", { class: "ed-label", text: "GitHub token (fine-grained, this repo only)" }),
            tokenField,
          ];
      const form = h("form", { class: "ed-modal__panel", novalidate: true }, [
        h("p", { class: "ed-modal__kicker", text: "Edit mode" }),
        h("h2", { class: "ed-modal__title", text: sealed ? "Unlock the editor" : "Set up saving" }),
        ...body,
        err,
        h("div", { class: "ed-modal__row" }, [submit, local, cancel]),
      ]);
      const modal = h("div", { class: "ed-modal ed-ui", role: "dialog", "aria-modal": "true" }, form);
      document.body.append(modal);
      setTimeout(() => code.focus(), 50);
      const done = (val) => {
        modal.remove();
        resolve(val);
      };
      cancel.addEventListener("click", () => done({ mode: "cancel" }));
      local.addEventListener("click", () => done({ mode: "local" }));
      modal.addEventListener("keydown", (e) => {
        if (e.key === "Escape") done({ mode: "cancel" });
      });
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const c = normCode(code.value);
        if (!c) return;
        submit.disabled = true;
        err.textContent = sealed ? "Checking…" : "Checking the token…";
        try {
          if (sealed) {
            const tok = await openToken(c, sealed);
            done({ mode: "save", token: tok });
            return;
          }
          const tok = tokenField.value.trim();
          if (!tok) throw new Error("Paste the GitHub token.");
          await getSha("index.html", tok); // proves the token can read this repo
          const blob = await sealToken(c, tok);
          await putFile("editor.json", b64(enc.encode(`${JSON.stringify(blob, null, 2)}\n`)), "Set up the web editor (encrypted token)", tok);
          tokenField.value = "";
          done({ mode: "save", token: tok });
        } catch (ex) {
          submit.disabled = false;
          err.textContent = sealed ? "That code doesn't open the editor." : `Setup failed: ${ex.message || ex}`;
          if (sealed) code.select();
        }
      });
    });
  }

  // ------------------------------------------------------------------ editable text
  function markEditable(on = true) {
    deck.querySelectorAll("[contenteditable]").forEach((el) => el.removeAttribute("contenteditable"));
    if (!on) return;
    deck.querySelectorAll(".slide *").forEach((el) => {
      if (el.closest("button, .switch, template, .ed-ui")) return;
      if (el.parentElement && el.parentElement.closest('[contenteditable="true"]')) return;
      const hasText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
      if (hasText || el.hasAttribute("data-edit")) el.setAttribute("contenteditable", "true");
    });
  }
  const isText = (el) => el && el.getAttribute("contenteditable") === "true";
  const activeSlide = () => D.slides[D.index];

  // ------------------------------------------------------------------ undo
  function snapshot() {
    undoStack.push(deck.innerHTML);
    if (undoStack.length > 60) undoStack.shift();
    markDirty();
  }
  function undo() {
    const prev = undoStack.pop();
    if (prev == null) return status("Nothing to undo.");
    const keep = D.index;
    deck.innerHTML = prev;
    select(null);
    D.rebuild(keep);
    markEditable();
    markDirty();
    status("Undone.");
  }
  function markDirty() {
    dirty = true;
    if (ui) ui.save.classList.add("is-dirty");
  }

  // ------------------------------------------------------------------ selection
  function select(el) {
    if (selected) selected.classList.remove("ed-selected");
    selected = el && deck.contains(el) ? el : null;
    if (selected) selected.classList.add("ed-selected");
    refreshTools();
  }
  function pickTarget(node) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el || !el.closest(".slide")) return null;
    return el.closest('[contenteditable="true"], img, .fig, [data-box]') || el.closest(".slide__inner > *");
  }
  // Block-level parent inside the slide (where new blocks are inserted after).
  function blockOf(el) {
    let cur = el;
    while (cur && cur.parentElement && !cur.parentElement.classList.contains("slide__inner")) {
      if (cur.parentElement.classList.contains("slide")) return null;
      cur = cur.parentElement;
    }
    return cur && cur.parentElement && cur.parentElement.classList.contains("slide__inner") ? cur : null;
  }
  function zoomOf(el) {
    let z = 1;
    for (let cur = el; cur && cur !== deck; cur = cur.parentElement) z *= parseFloat(cur.style.zoom || "1") || 1;
    return z;
  }
  function readTranslate(el) {
    const parts = (el.style.translate || "0px 0px").split(/\s+/).map((v) => parseFloat(v) || 0);
    return { x: parts[0] || 0, y: parts[1] || 0 };
  }
  function setTranslate(el, x, y) {
    el.style.translate = x || y ? `${Math.round(x)}px ${Math.round(y)}px` : "";
  }

  // ------------------------------------------------------------------ element actions
  const act = {
    size(dir) {
      if (!selected) return status("Select a text or block first.");
      snapshot();
      if (isText(selected)) {
        const px = parseFloat(getComputedStyle(selected).fontSize);
        const step = px < 24 ? 1 : px < 48 ? 2 : 4;
        selected.style.fontSize = `${Math.max(8, Math.round(px + dir * step))}px`;
      } else {
        const z = parseFloat(selected.style.zoom || "1") || 1;
        selected.style.zoom = String(Math.max(0.3, Math.round((z + dir * 0.05) * 100) / 100));
      }
      refreshTools();
    },
    font() {
      if (!selected) return;
      snapshot();
      const serif = /Source Serif/i.test(getComputedStyle(selected).fontFamily);
      selected.style.fontFamily = serif ? "var(--sans)" : "var(--serif)";
      refreshTools();
    },
    bold() {
      if (!isText(selected)) return status("Select some text first.");
      snapshot();
      document.execCommand("bold");
    },
    align(where) {
      if (!selected) return;
      snapshot();
      selected.style.textAlign = where;
    },
    color(value) {
      if (!selected) return;
      snapshot();
      selected.style.color = value;
    },
    parent() {
      if (!selected) return;
      const p = selected.parentElement;
      if (!p || p.classList.contains("slide__inner") || p.classList.contains("slide")) return status("That is already a whole block.");
      select(p);
    },
    duplicate() {
      if (!selected) return;
      snapshot();
      const copy = selected.cloneNode(true);
      copy.classList.remove("ed-selected");
      copy.removeAttribute("id");
      copy.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
      selected.after(copy);
      markEditable();
      select(copy);
    },
    remove() {
      if (!selected) return;
      snapshot();
      const gone = selected;
      select(null);
      gone.remove();
      status("Deleted. Undo brings it back.");
    },
    reset() {
      if (!selected) return;
      snapshot();
      ["translate", "font-size", "zoom", "font-family", "text-align", "color"].forEach((p) => selected.style.removeProperty(p));
      if (!selected.getAttribute("style")) selected.removeAttribute("style");
      refreshTools();
    },
    nudge(dx, dy) {
      if (!selected) return;
      if (!typingSnapshot) snapshot();
      const t = readTranslate(selected);
      setTranslate(selected, t.x + dx, t.y + dy);
    },
    insert(kind) {
      const slide = activeSlide();
      if (!slide) return;
      const inner = slide.querySelector(".slide__inner") || slide;
      if (kind === "image") return pickImage();
      snapshot();
      const make = {
        text: () => h("p", { class: "tx", "data-edit": true, "data-reveal": true, text: "New text" }),
        heading: () => h("h3", { class: "tx tx--h", "data-edit": true, "data-reveal": true, text: "New heading" }),
        list: () =>
          h("ul", { class: "tx tx--list", "data-edit": true, "data-reveal": true }, [
            h("li", { text: "First point" }),
            h("li", { text: "Second point" }),
          ]),
        box: () => h("figure", { class: "fig fig--empty", "data-box": true, "data-reveal": true }),
      }[kind];
      const el = make();
      const after = selected && selected.closest(".slide") === slide ? blockOf(selected) : null;
      if (after) after.after(el);
      else inner.append(el);
      markEditable();
      select(el);
      if (isText(el)) {
        el.focus();
        document.getSelection().selectAllChildren(el);
      }
    },
  };

  // Images: picked from disk, scaled to at most 1800 px, kept inline until Save uploads them to assets/.
  function pickImage() {
    const input = h("input", { type: "file", accept: "image/*" });
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const src = await fileToDataURL(file);
        snapshot();
        const img = h("img", { src, alt: file.name.replace(/\.[^.]+$/, "") });
        const slide = activeSlide();
        let fig = selected && selected.closest(".fig");
        if (fig && fig.closest(".slide") === slide) {
          fig.classList.remove("fig--empty");
          fig.replaceChildren(img);
        } else {
          fig = h("figure", { class: "fig", "data-box": true, "data-reveal": true }, img);
          const after = selected && selected.closest(".slide") === slide ? blockOf(selected) : null;
          if (after) after.after(fig);
          else (slide.querySelector(".slide__inner") || slide).append(fig);
        }
        select(fig);
        status("Image added. Use A− / A+ to size it, the Move handle to place it.");
      } catch (err) {
        status("That image could not be read.", true);
      }
    });
    input.click();
  }
  async function fileToDataURL(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = rej;
        i.src = url;
      });
      const scale = Math.min(1, 1800 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      return file.type === "image/png" ? c.toDataURL("image/png") : c.toDataURL("image/jpeg", 0.85);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // ------------------------------------------------------------------ slide actions
  const TEMPLATES = {
    text: () => `<div class="slide__inner">
  <header class="head head--tight">
    <p class="eyebrow" data-reveal>Section</p>
    <h2 class="title title--m"><span class="line"><span>Slide title</span></span></h2>
  </header>
  <p class="tx" data-edit data-reveal>Write the point here.</p>
</div>`,
    opener: () => `<div class="slide__inner part">
  <p class="part__num" data-reveal>04</p>
  <div class="part__body">
    <p class="eyebrow" data-reveal>Part</p>
    <h2 class="part__word"><span class="line"><span>Word</span></span></h2>
    <p class="part__q" data-reveal>The question this part answers.</p>
  </div>
</div>`,
    image: () => `<div class="slide__inner split">
  <figure class="fig fig--empty" data-box data-reveal></figure>
  <div class="split__text">
    <p class="eyebrow" data-reveal>Section</p>
    <h2 class="title title--m"><span class="line"><span>Slide title</span></span></h2>
    <p class="tx" data-edit data-reveal>Write the point here.</p>
  </div>
</div>`,
    blank: () => `<div class="slide__inner">
  <h2 class="title title--m"><span class="line"><span>Slide title</span></span></h2>
</div>`,
  };
  const slideAct = {
    add(kind) {
      const cur = activeSlide();
      snapshot();
      let el;
      if (kind === "copy" && cur) {
        el = cur.cloneNode(true);
        el.querySelectorAll(".ed-selected").forEach((n) => n.classList.remove("ed-selected"));
        el.dataset.tab = `${cur.dataset.tab || "Slide"} (copy)`;
      } else {
        el = h("section", { class: "slide", "data-tab": "New slide", "data-tone": (cur && cur.dataset.tone) || "smoke" });
        el.innerHTML = (TEMPLATES[kind] || TEMPLATES.text)();
      }
      el.id = D.newId();
      if (cur) cur.after(el);
      else deck.append(el);
      select(null);
      D.rebuild(D.index + 1);
      markEditable();
      refreshSlidePanel();
      status("Slide added.");
    },
    move(dir) {
      const cur = activeSlide();
      if (!cur) return;
      const other = dir < 0 ? cur.previousElementSibling : cur.nextElementSibling;
      if (!other || !other.classList.contains("slide")) return;
      snapshot();
      if (dir < 0) other.before(cur);
      else other.after(cur);
      D.rebuild(D.index + dir);
      markEditable();
    },
    remove() {
      const cur = activeSlide();
      if (!cur || D.slides.length < 2) return status("A deck needs at least one slide.");
      snapshot();
      const at = D.index;
      select(null);
      cur.remove();
      D.rebuild(Math.min(at, D.slides.length - 2));
      markEditable();
      refreshSlidePanel();
      status("Slide deleted. Undo brings it back.");
    },
  };

  // ------------------------------------------------------------------ saving
  function cleanClone() {
    const clone = deck.cloneNode(true);
    clone.querySelectorAll("[contenteditable]").forEach((el) => el.removeAttribute("contenteditable"));
    clone.querySelectorAll(".ed-selected").forEach((el) => el.classList.remove("ed-selected"));
    clone.querySelectorAll(":scope > .slide").forEach((s) => {
      s.classList.remove("is-active", "is-before", "is-after");
      ["role", "aria-hidden", "aria-labelledby", "inert"].forEach((a) => s.removeAttribute(a));
    });
    clone.querySelectorAll(".qs").forEach((qs) => {
      qs.querySelectorAll(".qs__panel").forEach((p, i) => {
        p.classList.toggle("is-current", i === 0);
        p.classList.remove("is-replay");
        if (i === 0) {
          p.removeAttribute("inert");
          p.removeAttribute("aria-hidden");
        } else {
          p.setAttribute("inert", "");
          p.setAttribute("aria-hidden", "true");
        }
      });
    });
    clone.querySelectorAll(".switch").forEach((sw) =>
      sw.querySelectorAll("[data-panel]").forEach((b, i) => b.setAttribute("aria-selected", i === 0 ? "true" : "false"))
    );
    clone.querySelectorAll("[style]").forEach((el) => {
      el.style.removeProperty("--d");
      if (!el.getAttribute("style").trim()) el.removeAttribute("style");
    });
    clone.querySelectorAll('[class=""]').forEach((el) => el.removeAttribute("class"));
    return clone;
  }
  function deckText(clone) {
    return `<!-- Slides of the Harvey take-home review. Loaded by app.js at start; the web editor (press E) saves this file. -->\n${clone.innerHTML.trim()}\n`;
  }

  async function save() {
    if (!token) return download();
    status("Saving…");
    ui.save.disabled = true;
    try {
      const clone = cleanClone();
      const liveImgs = Array.from(deck.querySelectorAll("img"));
      const cloneImgs = Array.from(clone.querySelectorAll("img"));
      for (let i = 0; i < cloneImgs.length; i++) {
        const src = cloneImgs[i].getAttribute("src") || "";
        const m = src.match(/^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/);
        if (!m) continue;
        const ext = m[1] === "jpeg" ? "jpg" : m[1];
        const path = `assets/img-${(await sha256hex(m[2])).slice(0, 12)}.${ext}`;
        status(`Uploading ${path}…`);
        if (!(await getSha(path))) await putFile(path, m[2], `Add ${path} from the web editor`);
        cloneImgs[i].setAttribute("src", path);
        if (liveImgs[i]) liveImgs[i].setAttribute("src", path);
      }
      const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
      await putFile("deck.html", b64(enc.encode(deckText(clone))), `Edit slides on the web (${stamp} UTC)`);
      dirty = false;
      ui.save.classList.remove("is-dirty");
      status("Saved. The live site updates in about a minute.");
    } catch (err) {
      status(`Not saved. ${err.message || err}`, true);
    } finally {
      ui.save.disabled = false;
    }
  }
  function download() {
    const blob = new Blob([deckText(cleanClone())], { type: "text/html" });
    const a = h("a", { href: URL.createObjectURL(blob), download: "deck.html" });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    status("deck.html downloaded (this session has no save access).");
  }

  // ------------------------------------------------------------------ toolbar and panels
  function status(text, bad) {
    if (!ui) return;
    ui.status.textContent = text;
    ui.status.classList.toggle("is-bad", !!bad);
    clearTimeout(status.t);
    if (!bad) status.t = setTimeout(() => (ui.status.textContent = dirty ? "Unsaved changes" : ""), 4000);
  }

  function btn(label, title, onclick, extra = {}) {
    return h("button", { class: "ed-tool", type: "button", title, "aria-label": title, onclick, ...extra }, [label]);
  }
  function group(name, kids) {
    return h("div", { class: "ed-group", role: "group", "aria-label": name }, [h("span", { class: "ed-group__name", text: name }), ...kids]);
  }

  function buildUI() {
    const sizeOut = h("span", { class: "ed-size", text: "–" });
    const saveBtn = h("button", { class: "ed-tool ed-tool--save", type: "button", onclick: () => save(), text: token ? "Save" : "Download" });
    const statusEl = h("span", { class: "ed-status", role: "status", "aria-live": "polite" });
    const addSel = h("select", { class: "ed-select", "aria-label": "Add a slide" }, [
      h("option", { value: "", text: "+ Slide" }),
      h("option", { value: "text", text: "Title and text" }),
      h("option", { value: "opener", text: "Section opener" }),
      h("option", { value: "image", text: "Image and text" }),
      h("option", { value: "blank", text: "Blank" }),
      h("option", { value: "copy", text: "Copy of this slide" }),
    ]);
    addSel.addEventListener("change", () => {
      if (addSel.value) slideAct.add(addSel.value);
      addSel.value = "";
    });

    const bar = h("div", { class: "ed-bar ed-ui", role: "toolbar", "aria-label": "Slide editor" }, [
      h("span", { class: "ed-badge", text: token ? "Editing" : "Editing · not saving" }),
      group("Text", [
        btn("Aa", "Serif or sans", () => act.font()),
        btn("A−", "Smaller", () => act.size(-1)),
        sizeOut,
        btn("A+", "Larger", () => act.size(1)),
        btn(h("strong", { text: "B" }), "Bold (selected words)", () => act.bold()),
        btn("⟸", "Align left", () => act.align("left")),
        btn("≡", "Align centre", () => act.align("center")),
        btn("⟹", "Align right", () => act.align("right")),
        btn(h("i", { class: "ed-dot", style: "background:#f4f2ee" }), "Bright", () => act.color("var(--on-dark)")),
        btn(h("i", { class: "ed-dot", style: "background:rgba(244,242,238,.62)" }), "Soft", () => act.color("var(--muted)")),
        btn(h("i", { class: "ed-dot", style: "background:#c9a46a" }), "Ochre accent", () => act.color("#c9a46a")),
      ]),
      group("Block", [
        btn("↑", "Select the block around it", () => act.parent()),
        btn("⧉", "Duplicate", () => act.duplicate()),
        btn("⟲", "Reset size, place and style", () => act.reset()),
        btn("✕", "Delete", () => act.remove(), { "data-danger": true }),
      ]),
      group("Insert", [
        btn("Text", "Insert a text box", () => act.insert("text")),
        btn("Heading", "Insert a heading", () => act.insert("heading")),
        btn("List", "Insert a bullet list", () => act.insert("list")),
        btn("Image", "Insert an image", () => act.insert("image")),
      ]),
      group("Slide", [
        addSel,
        btn("◀", "Move slide earlier", () => slideAct.move(-1)),
        btn("▶", "Move slide later", () => slideAct.move(1)),
        btn("⚙", "Slide settings: tab, tone, notes, delete", () => togglePanel()),
      ]),
      h("div", { class: "ed-end" }, [
        statusEl,
        btn("↶", "Undo", () => undo()),
        saveBtn,
        btn("Exit", "Leave edit mode", () => close()),
      ]),
    ]);

    // slide settings drawer
    const tabInput = h("input", { class: "ed-input", type: "text", "aria-label": "Tab label" });
    const toneSel = h("select", { class: "ed-input", "aria-label": "Background tone" },
      ["dusk", "smoke", "moss", "ochre", "slate"].map((t) => h("option", { value: t, text: t }))
    );
    const notesArea = h("textarea", { class: "ed-input ed-notes", rows: "7", "aria-label": "Speaker notes" });
    const delSlide = h("button", { class: "ed-btn ed-btn--danger", type: "button", text: "Delete this slide" });
    tabInput.addEventListener("focus", () => snapshot());
    tabInput.addEventListener("input", () => {
      const s = activeSlide();
      if (!s) return;
      s.dataset.tab = tabInput.value;
      const label = document.querySelector(`#tab-${CSS.escape(s.id)} .tab__label`);
      if (label) label.textContent = tabInput.value || `Slide ${D.index + 1}`;
    });
    toneSel.addEventListener("change", () => {
      const s = activeSlide();
      if (!s) return;
      snapshot();
      s.dataset.tone = toneSel.value;
      document.body.dataset.tone = toneSel.value;
    });
    notesArea.addEventListener("focus", () => snapshot());
    notesArea.addEventListener("input", () => {
      const s = activeSlide();
      if (!s) return;
      let tpl = s.querySelector("template.notes");
      if (!tpl) {
        tpl = h("template", { class: "notes" });
        s.append(tpl);
      }
      tpl.innerHTML = "";
      tpl.content.append(document.createTextNode(notesArea.value));
      const body = document.querySelector(".notes-panel__body");
      if (body) body.textContent = notesArea.value.trim() || "No notes for this slide.";
    });
    let armed = false;
    delSlide.addEventListener("click", () => {
      if (!armed) {
        armed = true;
        delSlide.textContent = "Click again to delete";
        setTimeout(() => {
          armed = false;
          delSlide.textContent = "Delete this slide";
        }, 3000);
        return;
      }
      armed = false;
      delSlide.textContent = "Delete this slide";
      slideAct.remove();
    });
    const panel = h("aside", { class: "ed-panel ed-ui", "aria-label": "Slide settings" }, [
      h("p", { class: "ed-panel__title", text: "This slide" }),
      h("label", { class: "ed-label", text: "Tab label" }),
      tabInput,
      h("label", { class: "ed-label", text: "Background tone" }),
      toneSel,
      h("label", { class: "ed-label", text: "Speaker notes (press N to show)" }),
      notesArea,
      delSlide,
      h("p", {
        class: "ed-panel__help",
        text:
          "Click text to edit it. Click a block, then use the Move handle or Alt + arrows (Shift for 10 px). " +
          "↑ selects the block around a selection. Cmd/Ctrl + S saves, Cmd/Ctrl + Z undoes, Delete removes a selected block.",
      }),
    ]);

    // selection outline with a move handle
    const grip = h("button", { class: "ed-grip", type: "button", title: "Drag to move", text: "Move" });
    const sel = h("div", { class: "ed-sel ed-ui", "aria-hidden": "true" }, [grip]);

    document.body.append(bar, panel, sel);
    ui = { bar, panel, sel, grip, sizeOut, save: saveBtn, status: statusEl, tabInput, toneSel, notesArea };
    grip.addEventListener("pointerdown", startDrag);
  }

  function togglePanel(force) {
    const open = typeof force === "boolean" ? force : !ui.panel.classList.contains("is-open");
    ui.panel.classList.toggle("is-open", open);
    if (open) refreshSlidePanel();
  }
  function refreshSlidePanel() {
    const s = activeSlide();
    if (!ui || !s) return;
    ui.tabInput.value = s.dataset.tab || "";
    ui.toneSel.value = s.dataset.tone || "dusk";
    const tpl = s.querySelector("template.notes");
    ui.notesArea.value = tpl ? tpl.content.textContent.trim() : "";
  }
  function refreshTools() {
    if (!ui) return;
    ui.sizeOut.textContent = selected
      ? isText(selected)
        ? `${Math.round(parseFloat(getComputedStyle(selected).fontSize))}px`
        : `${Math.round((parseFloat(selected.style.zoom || "1") || 1) * 100)}%`
      : "–";
  }

  // Keep the selection outline on the selected element (cheap: one rect per frame while editing).
  function frame() {
    if (!html.classList.contains("editing")) return;
    if (selected && deck.contains(selected) && selected.closest(".slide.is-active")) {
      const r = selected.getBoundingClientRect();
      Object.assign(ui.sel.style, { display: "block", left: `${r.left - 4}px`, top: `${r.top - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px` });
    } else ui.sel.style.display = "none";
    loop = requestAnimationFrame(frame);
  }

  // Drag the selection by its handle; the offset is stored as the element's translate.
  function startDrag(e) {
    if (!selected) return;
    e.preventDefault();
    snapshot();
    const el = selected;
    const start = readTranslate(el);
    const z = zoomOf(el);
    const x0 = e.clientX;
    const y0 = e.clientY;
    ui.grip.setPointerCapture(e.pointerId);
    const move = (ev) => setTranslate(el, start.x + (ev.clientX - x0) / z, start.y + (ev.clientY - y0) / z);
    const up = () => {
      ui.grip.removeEventListener("pointermove", move);
      ui.grip.removeEventListener("pointerup", up);
      ui.grip.removeEventListener("pointercancel", up);
    };
    ui.grip.addEventListener("pointermove", move);
    ui.grip.addEventListener("pointerup", up);
    ui.grip.addEventListener("pointercancel", up);
  }

  // ------------------------------------------------------------------ events while editing
  function onPointerDown(e) {
    if (!html.classList.contains("editing") || e.target.closest(".ed-ui")) return;
    const target = pickTarget(e.target);
    if (target && target !== selected) select(target);
    else if (!target && e.target.closest(".deck")) select(null);
  }
  function onClick(e) {
    if (!html.classList.contains("editing")) return;
    if (e.target.closest(".slide a")) e.preventDefault(); // cards are links: edit them, don't follow them
  }
  function onBeforeInput(e) {
    if (!isText(e.target.closest && e.target.closest('[contenteditable="true"]'))) return;
    if (!typingSnapshot) {
      snapshot();
      typingSnapshot = true;
    }
    clearTimeout(onBeforeInput.t);
    onBeforeInput.t = setTimeout(() => (typingSnapshot = false), 1200);
  }
  function onKey(e) {
    if (!html.classList.contains("editing")) return;
    const inText = e.target.closest && e.target.closest('[contenteditable="true"], input, textarea, select');
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
    } else if (mod && e.key.toLowerCase() === "z" && !e.shiftKey && !inText) {
      e.preventDefault();
      undo();
    } else if (mod && e.key.toLowerCase() === "d" && selected) {
      e.preventDefault();
      act.duplicate();
    } else if (e.altKey && e.key.startsWith("Arrow") && selected) {
      e.preventDefault();
      const s = e.shiftKey ? 10 : 1;
      act.nudge(e.key === "ArrowLeft" ? -s : e.key === "ArrowRight" ? s : 0, e.key === "ArrowUp" ? -s : e.key === "ArrowDown" ? s : 0);
    } else if (e.key === "Escape") {
      if (inText) e.target.blur();
      else if (selected) select(null);
      else return;
      e.preventDefault();
    } else if ((e.key === "Delete" || e.key === "Backspace") && selected && !inText) {
      e.preventDefault();
      act.remove();
    }
  }
  function onBeforeUnload(e) {
    if (dirty && token) {
      e.preventDefault();
      e.returnValue = "";
    }
  }
  function onSlideChange() {
    if (selected && !selected.closest(".slide.is-active")) select(null);
    refreshSlidePanel();
  }

  // ------------------------------------------------------------------ open / close
  async function open() {
    if (html.classList.contains("editing")) return;
    const res = await unlockDialog();
    if (res.mode === "cancel") return;
    token = res.mode === "save" ? res.token : null;
    html.classList.add("editing");
    buildUI();
    markEditable();
    deck.addEventListener("pointerdown", onPointerDown, true);
    deck.addEventListener("click", onClick, true);
    deck.addEventListener("beforeinput", onBeforeInput, true);
    deck.addEventListener("deck:change", onSlideChange);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("beforeunload", onBeforeUnload);
    refreshSlidePanel();
    loop = requestAnimationFrame(frame);
    status(token ? "Click any text to edit it." : "Editing without save access: Save downloads deck.html.");
  }
  function close() {
    select(null);
    markEditable(false);
    html.classList.remove("editing");
    cancelAnimationFrame(loop);
    deck.removeEventListener("pointerdown", onPointerDown, true);
    deck.removeEventListener("click", onClick, true);
    deck.removeEventListener("beforeinput", onBeforeInput, true);
    deck.removeEventListener("deck:change", onSlideChange);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("beforeunload", onBeforeUnload);
    if (ui) [ui.bar, ui.panel, ui.sel].forEach((n) => n.remove());
    ui = null;
    D.rebuild(D.index); // re-stagger reveals for anything added
  }

  // Round-trip check for the token sealing, callable from the console: DeckEditor.selfTest()
  async function selfTest() {
    const blob = await sealToken("1234", "dummy-value");
    const back = await openToken("1234", blob);
    let wrong = false;
    try {
      await openToken("4321", blob);
    } catch (err) {
      wrong = true;
    }
    return back === "dummy-value" && wrong;
  }

  // serialize(): the deck.html text Save would write (handy for checking, or copying by hand).
  window.DeckEditor = { open, close, selfTest, serialize: () => deckText(cleanClone()) };
})();
