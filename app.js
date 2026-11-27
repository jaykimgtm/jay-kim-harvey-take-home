// Harvey take-home review: slide navigation.
// Tabs are built from the <section class="slide"> elements (data-tab = label, data-tone = painted ground).
// Keys: ← → ↑ ↓ PageUp PageDown Space move, Home/End, 1–9 jump, N notes, F full screen. Hash #n deep-links.
(() => {
  const slides = Array.from(document.querySelectorAll(".slide"));
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
  let index = -1;

  // ---------------------------------------------------------------- access gate
  // The boot script in <head> already set html[data-gate]. Only the salted SHA-256 is on the page.
  const html = document.documentElement;
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

  // Stagger order for reveals: DOM order inside each slide.
  slides.forEach((slide, i) => {
    slide.setAttribute("role", "tabpanel");
    if (!slide.id) slide.id = `slide-${i + 1}`;
    slide.classList.add("is-after");
    let d = 0;
    slide.querySelectorAll("[data-reveal], .line").forEach((el) => el.style.setProperty("--d", d++));
  });

  // One tab per slide.
  const tabs = slides.map((slide, i) => {
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

  function go(target) {
    const i = Math.max(0, Math.min(slides.length - 1, target));
    if (i === index) return;
    const first = index < 0;
    index = i;

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
    if (location.hash !== hash) history.replaceState(null, "", hash);
  }

  function fromHash() {
    const h = decodeURIComponent(location.hash.slice(1));
    if (!h) return 0;
    if (/^\d+$/.test(h)) return Number(h) - 1;
    const byId = slides.findIndex((s) => s.id === h);
    return byId >= 0 ? byId : 0;
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

  // Keyboard.
  window.addEventListener("keydown", (e) => {
    if (!isOpen() || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target && e.target.closest && e.target.closest("input, textarea, select")) return;
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
    } else if (k === "Escape") {
      toggleNotes(false);
    }
  });

  // Buttons: prev/next and in-slide links (data-go="<slide id>").
  document.addEventListener("click", (e) => {
    const step = e.target.closest("[data-step]");
    if (step) return go(index + Number(step.dataset.step));
    const link = e.target.closest("[data-go]");
    if (link) {
      const i = slides.findIndex((s) => s.id === link.dataset.go);
      if (i >= 0) go(i);
    }
  });

  // Swipe on touch screens.
  const deck = document.getElementById("deck");
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
      if (sx === null) return;
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

  // Start once the faces are in (so the opening reveal runs on the real type, fallback after 700 ms) and the
  // gate is open. Unlocking calls begin() again.
  let fontsReady = false;
  let began = false;
  function begin() {
    if (began || !fontsReady || !isOpen()) return;
    began = true;
    requestAnimationFrame(() => requestAnimationFrame(() => go(fromHash())));
    // The key hint fades after a few seconds.
    setTimeout(() => keys && keys.classList.add("is-hidden"), 6000);
  }
  const fontsIn = () => {
    fontsReady = true;
    begin();
  };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fontsIn);
  setTimeout(fontsIn, 700);
})();
