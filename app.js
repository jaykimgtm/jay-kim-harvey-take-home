// Harvey take-home review: deck runtime.
// The slides live in deck.html, fetched at start so the web editor can save them. Tabs are built from the
// <section class="slide"> elements: data-tab = tab label, data-tone = painted ground.
// Keys: ← → ↑ ↓ PageUp PageDown Space move, Home/End, 1–9 jump, N notes, F full screen, R switch role (if a slide has a role switch),
// E edit (asks for the save code; also ?edit in the URL). Hash #n or #slide-id deep-links.
(() => {
  const html = document.documentElement;
  const deck = document.getElementById("deck");
  const track = document.querySelector(".tabs__track");
  const ink = document.querySelector(".tabs__ink");
  const count = document.querySelector(".tabs__count");
  const progress = document.querySelector(".bar__progress i");
  const prevBtn = document.querySelector('.ctl[data-step="-1"]');
  const nextBtn = document.querySelector('.ctl[data-step="1"]');
  const notes = document.getElementById("notes");
  const notesBody = notes.querySelector(".notes-panel__body");
  const keys = document.querySelector(".keys");
  const pad = (n) => String(n).padStart(2, "0");
  const editing = () => html.classList.contains("editing");
  let slides = [];
  let tabs = [];
  let index = -1;

  // ---------------------------------------------------------------- access gate
  // The boot script in <head> already set html[data-gate]. Only the salted SHA-256 is on the page.
  const gate = document.getElementById("gate");
  const gateForm = document.getElementById("gate-form");
  const gateInput = document.getElementById("gate-code");
  const gateError = document.getElementById("gate-error");
  const GATE_KEY = "jk-harvey-take-home-gate";
  const GATE_SALT = "jay-kim-harvey-take-home";
  const GATE_DIGEST = document.querySelector('meta[name="gate-digest"]').content;
  const isOpen = () => html.getAttribute("data-gate") === "open";

  async function sha256hex(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function sealGate() {
    gate.setAttribute("aria-hidden", "true");
    gate.inert = true;
  }

  if (isOpen()) sealGate();
  else setTimeout(() => gateInput.focus(), 400);

  gateForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = gateInput.value.normalize("NFKC").trim();
    if (!code) return;
    let got = "";
    try {
      got = await sha256hex(`${GATE_SALT}:${code}`);
    } catch (err) {
      gateError.textContent = "This browser can't check the code on this page. Open it over https.";
      return;
    }
    if (got === GATE_DIGEST) {
      try {
        localStorage.setItem(GATE_KEY, GATE_DIGEST);
      } catch (err) {
        /* private mode: stays open for this visit only */
      }
      gateError.textContent = "";
      gateInput.value = "";
      gateInput.blur();
      html.setAttribute("data-gate", "open");
      sealGate();
      begin();
    } else {
      gateError.textContent = "That code doesn't match.";
      gate.classList.remove("is-wrong");
      void gate.offsetWidth; // restart the nudge animation
      gate.classList.add("is-wrong");
      gateInput.select();
    }
  });

  // ---------------------------------------------------------------- slides and tabs
  function newId() {
    return `slide-${Math.random().toString(36).slice(2, 8)}`;
  }

  // (Re)reads the slides from the DOM: ids, stagger order for reveals, one tab per slide.
  function prepare() {
    slides = Array.from(deck.querySelectorAll(":scope > .slide"));
    const seen = new Set();
    slides.forEach((slide) => {
      if (!slide.id || seen.has(slide.id)) slide.id = newId();
      seen.add(slide.id);
      slide.setAttribute("role", "tabpanel");
      let d = 0;
      slide.querySelectorAll("[data-reveal], .line").forEach((el) => el.style.setProperty("--d", d++));
    });
    track.querySelectorAll(".tab").forEach((t) => t.remove());
    tabs = slides.map((slide, i) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "tab";
      tab.id = `tab-${slide.id}`;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", slide.id);
      tab.innerHTML = `<span class="tab__num">${pad(i + 1)}</span><span class="tab__label"></span>`;
      tab.querySelector(".tab__label").textContent = slide.dataset.tab || `Slide ${i + 1}`;
      tab.addEventListener("click", () => go(i));
      slide.setAttribute("aria-labelledby", tab.id);
      track.appendChild(tab);
      return tab;
    });
  }

  function moveInk() {
    const tab = tabs[index];
    if (!tab) return;
    ink.style.width = `${tab.offsetWidth}px`;
    ink.style.transform = `translateX(${tab.offsetLeft}px)`;
  }

  function showNotes() {
    const tpl = slides[index] && slides[index].querySelector("template.notes");
    const text = tpl ? tpl.content.textContent.trim() : "";
    notesBody.textContent = text || "No notes for this slide.";
  }

  function go(target, force) {
    if (!slides.length) return;
    const i = Math.max(0, Math.min(slides.length - 1, target));
    if (i === index && !force) return;
    const first = index < 0;
    index = i;
    if (!first && !force && keys) keys.classList.add("is-hidden");

    slides.forEach((slide, k) => {
      slide.classList.toggle("is-active", k === i);
      slide.classList.toggle("is-before", k < i);
      slide.classList.toggle("is-after", k > i);
      slide.setAttribute("aria-hidden", k === i ? "false" : "true");
      slide.inert = k !== i;
    });
    const tabHadFocus = tabs.includes(document.activeElement);
    tabs.forEach((tab, k) => {
      tab.setAttribute("aria-selected", k === i ? "true" : "false");
      tab.tabIndex = k === i ? 0 : -1;
    });
    // Keep keyboard focus on the selected tab, so a focus ring never sits on a stale one.
    if (tabHadFocus) tabs[i].focus({ preventScroll: true });

    document.body.dataset.tone = slides[i].dataset.tone || "dusk";
    progress.style.transform = `scaleX(${(i + 1) / slides.length})`;
    count.textContent = `${pad(i + 1)} / ${pad(slides.length)}`;
    prevBtn.disabled = i === 0;
    nextBtn.disabled = i === slides.length - 1;
    moveInk();
    tabs[i].scrollIntoView({ block: "nearest", inline: "nearest", behavior: first ? "auto" : "smooth" });
    showNotes();

    const hash = `#${i + 1}`;
    if (location.hash !== hash) history.replaceState(null, "", location.pathname + location.search + hash);
    deck.dispatchEvent(new CustomEvent("deck:change", { detail: { index: i } }));
  }

  // After the editor adds, removes or reorders slides.
  function rebuild(target) {
    const keep = typeof target === "number" ? target : Math.max(0, index);
    prepare();
    index = -1;
    go(keep, true);
  }

  function fromHash() {
    const h = decodeURIComponent(location.hash.slice(1));
    if (!h) return 0;
    if (/^\d+$/.test(h)) return Number(h) - 1;
    const byId = slides.findIndex((s) => s.id === h);
    return byId >= 0 ? byId : Math.max(0, index);
  }

  function toggleNotes(force) {
    const open = typeof force === "boolean" ? force : !notes.classList.contains("is-open");
    notes.classList.toggle("is-open", open);
    notes.setAttribute("aria-hidden", open ? "false" : "true");
    document.body.classList.toggle("notes-open", open);
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen && document.exitFullscreen();
    else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
  }

  // Role switch (Part 1 questions): one role's panel at a time; R toggles it on the current slide.
  function selectPanel(btn) {
    const sw = btn.closest(".switch");
    const scope = btn.closest(".slide");
    if (!sw || !scope) return;
    sw.querySelectorAll("[data-panel]").forEach((b) => b.setAttribute("aria-selected", b === btn ? "true" : "false"));
    scope.querySelectorAll(".qs__panel").forEach((panel) => {
      const on = panel.id === btn.dataset.panel;
      if (on && !panel.classList.contains("is-current")) {
        panel.classList.remove("is-replay");
        void panel.offsetWidth; // restart the row stagger
        panel.classList.add("is-replay");
      }
      panel.classList.toggle("is-current", on);
      panel.inert = !on;
      panel.setAttribute("aria-hidden", on ? "false" : "true");
    });
  }

  // ---------------------------------------------------------------- editor (loaded on demand)
  let editorLoading = null;
  function loadEditor() {
    if (window.DeckEditor) return Promise.resolve(window.DeckEditor);
    if (editorLoading) return editorLoading;
    editorLoading = new Promise((resolve, reject) => {
      const v = (document.querySelector('script[src^="app.js"]').getAttribute("src").split("?v=")[1]) || "1";
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = `editor.css?v=${v}`;
      document.head.appendChild(css);
      const js = document.createElement("script");
      js.src = `editor.js?v=${v}`;
      js.onload = () => resolve(window.DeckEditor);
      js.onerror = () => {
        editorLoading = null;
        reject(new Error("editor.js did not load"));
      };
      document.body.appendChild(js);
    });
    return editorLoading;
  }
  function openEditor() {
    if (!isOpen() || editing()) return;
    loadEditor()
      .then((ed) => ed.open())
      .catch(() => {});
  }

  // ---------------------------------------------------------------- input
  window.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || !isOpen() || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"], .ed-ui')) return;
    const k = e.key;
    if (k === "ArrowRight" || k === "ArrowDown" || k === "PageDown" || k === " ") {
      e.preventDefault();
      go(index + 1);
    } else if (k === "ArrowLeft" || k === "ArrowUp" || k === "PageUp") {
      e.preventDefault();
      go(index - 1);
    } else if (k === "Home") {
      e.preventDefault();
      go(0);
    } else if (k === "End") {
      e.preventDefault();
      go(slides.length - 1);
    } else if (/^[1-9]$/.test(k)) {
      go(Number(k) - 1);
    } else if (k === "n" || k === "N") {
      toggleNotes();
    } else if (k === "f" || k === "F") {
      toggleFullscreen();
    } else if (k === "r" || k === "R") {
      const other = slides[index] && slides[index].querySelector('.switch [aria-selected="false"]');
      if (other) selectPanel(other);
    } else if (k === "e" || k === "E") {
      openEditor();
    } else if (k === "Escape") {
      toggleNotes(false);
    }
  });

  document.addEventListener("click", (e) => {
    const step = e.target.closest("[data-step]");
    if (step) return go(index + Number(step.dataset.step));
    const panelBtn = e.target.closest("[data-panel]");
    if (panelBtn) return selectPanel(panelBtn);
  });

  // Swipe on touch screens.
  let sx = null;
  let sy = null;
  deck.addEventListener(
    "touchstart",
    (e) => {
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
    },
    { passive: true }
  );
  deck.addEventListener(
    "touchend",
    (e) => {
      if (sx === null || editing()) return;
      const dx = e.changedTouches[0].clientX - sx;
      const dy = e.changedTouches[0].clientY - sy;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.2) go(index + (dx < 0 ? 1 : -1));
      sx = null;
    },
    { passive: true }
  );

  window.addEventListener("hashchange", () => {
    if (began) go(fromHash());
  });
  window.addEventListener("resize", moveInk);

  // What the editor needs from the deck.
  window.Deck = {
    deck,
    get slides() {
      return slides;
    },
    get index() {
      return index;
    },
    go,
    rebuild,
    newId,
    selectPanel,
  };

  // ---------------------------------------------------------------- start
  // Begin once the slides are loaded, the faces are in (fallback after 700 ms) and the gate is open.
  let deckReady = false;
  let fontsReady = false;
  let began = false;
  function begin() {
    if (began || !deckReady || !fontsReady || !isOpen()) return;
    began = true;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        go(fromHash());
        if (/[?&]edit\b/.test(location.search)) openEditor();
      })
    );
    // The key hint fades after a few seconds.
    setTimeout(() => keys && keys.classList.add("is-hidden"), 6000);
  }

  async function loadDeck() {
    try {
      const res = await fetch(`deck.html?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      deck.innerHTML = await res.text();
    } catch (err) {
      deck.innerHTML =
        '<section class="slide" data-tab="Error" data-tone="smoke"><div class="slide__inner">' +
        '<h2 class="title title--m">The slides could not load.</h2>' +
        '<p class="lead">Reload the page. A file opened straight from disk cannot load them: serve the folder over http.</p>' +
        "</div></section>";
    }
    prepare();
    deckReady = true;
    begin();
  }

  const fontsIn = () => {
    fontsReady = true;
    begin();
  };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fontsIn);
  setTimeout(fontsIn, 700);
  loadDeck();
})();
