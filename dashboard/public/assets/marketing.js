/* ==========================================================================
   GetQualify. Marketing landing behavior.
   Pure vanilla JS, zero dependencies. Progressive enhancement only.
   Content is visible by default. JS only adds motion and safety nets.
   No em dashes anywhere. Use commas or periods.
   ========================================================================== */
(function () {
  "use strict";

  // 1) Mark JS available so the .reveal pattern can hide-then-reveal.
  //    If this script never runs, content stays fully visible. Bulletproof.
  document.documentElement.classList.add("js");

  var prefersReduced = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Brand voltage stops, read from one place so we never refork colors.
  var VOLT = ["#34E7E4", "#22D3EE", "#6E7BFF", "#A855F7"];

  function ready(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn);
    } else {
      fn();
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Deterministic, on-brand gradient avatars (NO random stock faces).      */
  /* ---------------------------------------------------------------------- */
  function hashStr(s) {
    var h = 0, i;
    for (i = 0; i < s.length; i++) {
      h = (h << 5) - h + s.charCodeAt(i);
      h |= 0;
    }
    return Math.abs(h);
  }
  function initials(name) {
    var parts = (name || "").trim().split(/\s+/);
    var a = parts[0] ? parts[0][0] : "R";
    var b = parts[1] ? parts[1][0] : (parts[0] && parts[0][1] ? parts[0][1] : "X");
    return (a + b).toUpperCase();
  }
  function buildAvatars() {
    var nodes = document.querySelectorAll(".avatar[data-name]");
    Array.prototype.forEach.call(nodes, function (el) {
      var name = el.getAttribute("data-name") || "GetQualify";
      var h = hashStr(name);
      var c1 = VOLT[h % VOLT.length];
      var c2 = VOLT[(h >> 3) % VOLT.length];
      if (c1 === c2) { c2 = VOLT[(h + 2) % VOLT.length]; }
      var angle = 90 + (h % 180);
      el.style.background = "linear-gradient(" + angle + "deg, " + c1 + ", " + c2 + ")";
      el.textContent = initials(name);
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Branded SVG data-URI used by the image guard if any <img> fails.       */
  /* ---------------------------------------------------------------------- */
  function brandedDataUri(label) {
    var txt = (label || "GetQualify").replace(/[<>&"]/g, " ");
    var svg =
      "<svg xmlns='http://www.w3.org/2000/svg' width='640' height='400' viewBox='0 0 640 400'>" +
      "<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>" +
      "<stop offset='0' stop-color='#34E7E4'/><stop offset='0.55' stop-color='#6E7BFF'/>" +
      "<stop offset='1' stop-color='#A855F7'/></linearGradient></defs>" +
      "<rect width='640' height='400' fill='#0A0C12'/>" +
      "<rect width='640' height='400' fill='url(#g)' opacity='0.16'/>" +
      "<circle cx='320' cy='168' r='54' fill='none' stroke='url(#g)' stroke-width='3'/>" +
      "<path d='M300 168h6l5-16 9 32 5-16h10' fill='none' stroke='url(#g)' stroke-width='3' " +
      "stroke-linecap='round' stroke-linejoin='round'/>" +
      "<text x='320' y='280' fill='#F4F6FB' font-family='SF Pro Display, Inter, sans-serif' " +
      "font-size='26' font-weight='600' text-anchor='middle'>" + txt + "</text></svg>";
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }
  function guardImages() {
    var imgs = document.querySelectorAll("img");
    Array.prototype.forEach.call(imgs, function (img) {
      function swap() {
        if (img.getAttribute("data-guarded") === "1") { return; }
        img.setAttribute("data-guarded", "1");
        img.src = brandedDataUri(img.getAttribute("alt") || "GetQualify");
      }
      img.addEventListener("error", swap);
      // Already broken by the time we run (cached failure).
      if (img.complete && img.naturalWidth === 0) { swap(); }
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Scroll reveal: only ADD the .in class, never hide via JS.              */
  /* ---------------------------------------------------------------------- */
  function setupReveal() {
    var els = document.querySelectorAll(".reveal");
    if (prefersReduced || !("IntersectionObserver" in window)) {
      Array.prototype.forEach.call(els, function (el) { el.classList.add("in"); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
    Array.prototype.forEach.call(els, function (el) { io.observe(el); });
  }

  /* ---------------------------------------------------------------------- */
  /* Sticky nav state + mobile menu.                                        */
  /* ---------------------------------------------------------------------- */
  function setupNav() {
    var nav = document.getElementById("nav");
    var burger = document.getElementById("navBurger");
    var mobile = document.getElementById("navMobile");

    function onScroll() {
      if (!nav) { return; }
      if (window.scrollY > 12) { nav.classList.add("scrolled"); }
      else { nav.classList.remove("scrolled"); }
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    if (burger && mobile) {
      burger.addEventListener("click", function () {
        var open = burger.getAttribute("aria-expanded") === "true";
        burger.setAttribute("aria-expanded", String(!open));
        if (open) { mobile.hidden = true; }
        else { mobile.hidden = false; }
      });
      Array.prototype.forEach.call(mobile.querySelectorAll("a"), function (a) {
        a.addEventListener("click", function () {
          burger.setAttribute("aria-expanded", "false");
          mobile.hidden = true;
        });
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* FAQ accordion: <details> works without JS. JS makes it single-open.    */
  /* ---------------------------------------------------------------------- */
  function setupFaq() {
    var items = document.querySelectorAll(".faq-item");
    Array.prototype.forEach.call(items, function (item) {
      item.addEventListener("toggle", function () {
        if (!item.open) { return; }
        Array.prototype.forEach.call(items, function (other) {
          if (other !== item) { other.open = false; }
        });
      });
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Magnetic buttons: subtle pull toward the cursor. Pointer only.         */
  /* ---------------------------------------------------------------------- */
  function setupMagnetic() {
    if (prefersReduced) { return; }
    var fine = window.matchMedia && window.matchMedia("(pointer: fine)").matches;
    if (!fine) { return; }
    var btns = document.querySelectorAll(".magnetic");
    Array.prototype.forEach.call(btns, function (btn) {
      btn.addEventListener("mousemove", function (e) {
        var r = btn.getBoundingClientRect();
        var x = (e.clientX - r.left - r.width / 2) * 0.18;
        var y = (e.clientY - r.top - r.height / 2) * 0.28;
        btn.style.transform = "translate(" + x + "px," + y + "px)";
      });
      btn.addEventListener("mouseleave", function () {
        btn.style.transform = "";
      });
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Hero voltage canvas: layered waveform + breathing core. Pure JS.       */
  /* ---------------------------------------------------------------------- */
  function setupCanvas() {
    var canvas = document.getElementById("voiceCanvas");
    if (!canvas || !canvas.getContext) { return; }
    var ctx = canvas.getContext("2d");
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var raf = null;
    var running = true;

    function size() {
      var rect = canvas.getBoundingClientRect();
      var w = rect.width || 520;
      var h = rect.height || 520;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    size();
    window.addEventListener("resize", size);

    // Reduced motion: draw one static frame, do not animate.
    function gradLine() {
      var rect = canvas.getBoundingClientRect();
      var g = ctx.createLinearGradient(0, 0, rect.width || 520, 0);
      g.addColorStop(0, VOLT[0]);
      g.addColorStop(0.4, VOLT[2]);
      g.addColorStop(1, VOLT[3]);
      return g;
    }

    function frame(t) {
      if (!running) { return; }
      var rect = canvas.getBoundingClientRect();
      var w = rect.width || 520;
      var h = rect.height || 520;
      var cx = w / 2, cy = h / 2;
      var time = (t || 0) / 1000;

      ctx.clearRect(0, 0, w, h);

      // Breathing radial core.
      var pulse = 0.5 + 0.5 * Math.sin(time * 1.4);
      var coreR = Math.min(w, h) * (0.13 + pulse * 0.02);
      var rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 4);
      rg.addColorStop(0, "rgba(110,123,255," + (0.42 + pulse * 0.18) + ")");
      rg.addColorStop(0.5, "rgba(52,231,228,0.10)");
      rg.addColorStop(1, "rgba(110,123,255,0)");
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR * 4, 0, Math.PI * 2);
      ctx.fill();

      // Circular voltage waveform rings.
      var rings = 3;
      for (var r = 0; r < rings; r++) {
        var baseR = Math.min(w, h) * (0.20 + r * 0.085);
        var amp = Math.min(w, h) * (0.018 + r * 0.006);
        ctx.beginPath();
        for (var a = 0; a <= 360; a += 3) {
          var rad = (a * Math.PI) / 180;
          var wob =
            Math.sin(rad * (5 + r) + time * (1.6 + r * 0.5)) * amp +
            Math.sin(rad * (9 - r) - time * (1.0 + r * 0.3)) * amp * 0.5;
          var rr = baseR + wob;
          var x = cx + Math.cos(rad) * rr;
          var y = cy + Math.sin(rad) * rr;
          if (a === 0) { ctx.moveTo(x, y); } else { ctx.lineTo(x, y); }
        }
        ctx.closePath();
        ctx.strokeStyle = gradLine();
        ctx.globalAlpha = 0.85 - r * 0.22;
        ctx.lineWidth = 2 - r * 0.4;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // Horizontal bar equalizer across the middle, voice-meter feel.
      var bars = 40;
      var span = w * 0.62;
      var startX = cx - span / 2;
      var step = span / bars;
      ctx.strokeStyle = gradLine();
      ctx.lineWidth = step * 0.42;
      ctx.lineCap = "round";
      for (var i = 0; i < bars; i++) {
        var nx = startX + step * i + step / 2;
        var d = Math.abs(i - bars / 2) / (bars / 2);
        var env = 1 - d * 0.8;
        var bh =
          (Math.sin(time * 3 + i * 0.5) * 0.5 + 0.5) *
          (Math.min(w, h) * 0.14) * env + 4;
        ctx.globalAlpha = 0.55 * env + 0.15;
        ctx.beginPath();
        ctx.moveTo(nx, cy - bh / 2);
        ctx.lineTo(nx, cy + bh / 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      raf = window.requestAnimationFrame(frame);
    }

    if (prefersReduced) {
      frame(0);
      running = false;
      return;
    }

    // Pause when offscreen to save battery.
    if ("IntersectionObserver" in window) {
      var vio = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting && !raf && running !== false) {
            running = true;
            raf = window.requestAnimationFrame(frame);
          } else if (!e.isIntersecting && raf) {
            window.cancelAnimationFrame(raf);
            raf = null;
          }
        });
      }, { threshold: 0.05 });
      vio.observe(canvas);
    }
    raf = window.requestAnimationFrame(frame);
  }

  /* ---------------------------------------------------------------------- */
  /* Animate the cost compare fill once it scrolls into view.               */
  /* ---------------------------------------------------------------------- */
  function setupCompare() {
    var fill = document.querySelector(".compare .us-fill");
    if (!fill) { return; }
    if (prefersReduced || !("IntersectionObserver" in window)) { return; }
    var target = fill.style.width || "2.5%";
    fill.style.width = "0%";
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          window.requestAnimationFrame(function () { fill.style.width = target; });
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.4 });
    io.observe(fill);
  }

  /* ---------------------------------------------------------------------- */
  /* Final self-check: force-show anything stuck hidden, warn on issues.    */
  /* ---------------------------------------------------------------------- */
  function inOrAboveViewport(el) {
    // True if the element is on screen or has already scrolled past above it.
    // Below-the-fold pending reveals are left alone so the observer can animate them.
    var r = el.getBoundingClientRect();
    var vh = window.innerHeight || document.documentElement.clientHeight;
    return r.top < vh * 0.95;
  }
  function selfCheck() {
    // Rescue any .reveal that is in view but never received .in (observer missed).
    // Do NOT touch below-the-fold reveals, they animate on scroll as intended.
    var hidden = document.querySelectorAll(".reveal:not(.in)");
    if (hidden.length) {
      Array.prototype.forEach.call(hidden, function (el) {
        if (!inOrAboveViewport(el)) { return; }
        var cs = window.getComputedStyle(el);
        if (parseFloat(cs.opacity) < 0.99) {
          el.classList.add("in");
          el.style.opacity = "1";
          el.style.transform = "none";
        }
      });
    }
    // Catch any element computed at opacity 0 that is meant to be visible and in view.
    var all = document.querySelectorAll("main *, header *, footer *");
    var forced = 0;
    Array.prototype.forEach.call(all, function (el) {
      if (el.getAttribute("aria-hidden") === "true") { return; }
      if (el.classList.contains("reveal") && !el.classList.contains("in") && !inOrAboveViewport(el)) { return; }
      var cs = window.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") { return; }
      if (parseFloat(cs.opacity) === 0) {
        el.style.opacity = "1";
        forced++;
      }
    });
    if (forced) { console.warn("[GetQualify] force-showed " + forced + " element(s) stuck at opacity 0."); }

    // Warn on broken images.
    var broken = 0;
    Array.prototype.forEach.call(document.querySelectorAll("img"), function (img) {
      if (img.complete && img.naturalWidth === 0 && img.getAttribute("data-guarded") !== "1") {
        broken++;
        console.warn("[GetQualify] broken image:", img.getAttribute("src"));
      }
    });
    if (broken) { console.warn("[GetQualify] " + broken + " broken image(s) detected."); }

    // Warn if the hero H1 is missing.
    var h1 = document.querySelector(".hero-h1, h1");
    if (!h1 || !h1.textContent.trim()) {
      console.warn("[GetQualify] hero H1 missing or empty.");
    }
  }

  /* ---------------------------------------------------------------------- */
  ready(function () {
    buildAvatars();
    guardImages();
    setupReveal();
    setupNav();
    setupFaq();
    setupMagnetic();
    setupCanvas();
    setupCompare();
    // Run the self-check after layout settles, twice for cached/late paints.
    window.setTimeout(selfCheck, 600);
    window.addEventListener("load", function () { window.setTimeout(selfCheck, 200); });
  });
})();
