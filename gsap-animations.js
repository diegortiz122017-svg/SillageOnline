/**
 * gsap-animations.js — Sillage Parfumerie
 * Requires: GSAP + ScrollTrigger (loaded via CDN before this file)
 * Drop into project root. Add to index.html before </body>:
 *
 *   <script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"></script>
 *   <script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/ScrollTrigger.min.js"></script>
 *   <script src="/gsap-animations.js"></script>
 */

(function () {
  'use strict';

  // Bail silently if GSAP didn't load
  if (typeof gsap === 'undefined') {
    console.warn('gsap-animations: GSAP not found — animations disabled');
    return;
  }

  gsap.registerPlugin(ScrollTrigger);

  // ── Respect reduced motion ──────────────────────────────────────────────────
  var prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion) return;

  // ── Defaults ────────────────────────────────────────────────────────────────
  var EASE_OUT   = 'power3.out';
  var EASE_BACK  = 'back.out(1.4)';
  var STAGGER    = 0.07;
  var DURATION   = 0.75;

  // ────────────────────────────────────────────────────────────────────────────
  // 1. HERO — override the CSS fadeUp on key elements with GSAP for more control
  // ────────────────────────────────────────────────────────────────────────────
  (function initHero() {
    // Only run if hero elements exist and haven't been touched by CSS animation yet
    var eyebrow  = document.querySelector('.hero-eyebrow');
    var title    = document.querySelector('.hero-title');
    var sub      = document.querySelector('.hero-sub');
    var cta      = document.querySelector('.hero-cta');
    var divider  = document.querySelector('.hero-som-divider');
    var invite   = document.querySelector('#somInvite');
    var scroll   = document.querySelector('.scroll-indicator');

    if (!eyebrow) return;

    // Kill the CSS animations — we're taking over
    var heroEls = [eyebrow, title, sub, cta, divider, invite, scroll].filter(Boolean);
    heroEls.forEach(function (el) {
      el.style.animation = 'none';
      el.style.opacity   = '0';
    });

    var tl = gsap.timeline({ delay: 0.1 });

    tl.to(eyebrow, {
      opacity: 1,
      y: 0,
      duration: DURATION,
      ease: EASE_OUT,
      clearProps: 'transform',
    }, 0.2)
    .from(eyebrow, { y: 28 }, '<')

    .to(title, {
      opacity: 1,
      duration: DURATION + 0.1,
      ease: EASE_OUT,
    }, 0.4)
    .from(title, { y: 40, skewY: 1 }, '<')

    .to(sub, {
      opacity: 1,
      y: 0,
      duration: DURATION,
      ease: EASE_OUT,
    }, 0.65)
    .from(sub, { y: 22 }, '<')

    .to(cta, {
      opacity: 1,
      y: 0,
      duration: DURATION,
      ease: EASE_BACK,
    }, 0.85)
    .from(cta, { y: 18 }, '<');

    if (divider) {
      tl.to(divider, { opacity: 1, scaleX: 1, duration: 0.6, ease: EASE_OUT }, 1.1)
        .from(divider, { scaleX: 0 }, '<');
    }

    if (invite) {
      tl.to(invite, { opacity: 1, y: 0, duration: DURATION, ease: EASE_OUT }, 1.2)
        .from(invite, { y: 24 }, '<');
    }

    if (scroll) {
      tl.to(scroll, { opacity: 1, duration: 0.6, ease: EASE_OUT }, 1.5);
    }
  })();

  // ────────────────────────────────────────────────────────────────────────────
  // 2. MAGNETIC CTA BUTTON
  // ────────────────────────────────────────────────────────────────────────────
  (function initMagneticCTA() {
    var cta = document.querySelector('.hero-cta');
    if (!cta) return;

    var strength = 0.35;

    cta.addEventListener('mousemove', function (e) {
      var rect     = cta.getBoundingClientRect();
      var centerX  = rect.left + rect.width  / 2;
      var centerY  = rect.top  + rect.height / 2;
      var deltaX   = (e.clientX - centerX) * strength;
      var deltaY   = (e.clientY - centerY) * strength;

      gsap.to(cta, {
        x: deltaX,
        y: deltaY,
        duration: 0.4,
        ease: 'power2.out',
      });
    });

    cta.addEventListener('mouseleave', function () {
      gsap.to(cta, {
        x: 0,
        y: 0,
        duration: 0.6,
        ease: EASE_BACK,
      });
    });
  })();

  // ────────────────────────────────────────────────────────────────────────────
  // 3. SHOP SECTION — eyebrow + title reveal on scroll
  // ────────────────────────────────────────────────────────────────────────────
  (function initShopHeader() {
    var shop    = document.querySelector('#shop');
    var eyebrow = shop && shop.querySelector('.section-eyebrow');
    var title   = shop && shop.querySelector('.section-title');
    if (!eyebrow || !title) return;

    gsap.from([eyebrow, title], {
      opacity: 0,
      y: 40,
      duration: DURATION,
      ease: EASE_OUT,
      stagger: 0.15,
      scrollTrigger: {
        trigger: shop,
        start:   'top 80%',
        once:    true,
      },
    });
  })();

  // ────────────────────────────────────────────────────────────────────────────
  // 4. PRODUCT CARDS — staggered reveal
  // Cards are injected dynamically by renderProducts(), so we use
  // a MutationObserver to catch new cards and animate them in.
  // ────────────────────────────────────────────────────────────────────────────
  (function initProductCards() {
    var grid = document.querySelector('#productGrid');
    if (!grid) return;

    var animatedCards = new WeakSet();
    var pendingBatch  = [];
    var batchTimer    = null;

    function animateBatch(cards) {
      if (!cards.length) return;
      gsap.from(cards, {
        opacity: 0,
        y: 50,
        scale: 0.96,
        duration: 0.6,
        ease: EASE_OUT,
        stagger: STAGGER,
        clearProps: 'transform,opacity',
      });
      cards.forEach(function (c) { animatedCards.add(c); });
    }

    function scheduleAnimation(card) {
      if (animatedCards.has(card)) return;
      pendingBatch.push(card);
      clearTimeout(batchTimer);
      // Small delay so cards added in the same render cycle batch together
      batchTimer = setTimeout(function () {
        animateBatch(pendingBatch.slice());
        pendingBatch = [];
      }, 30);
    }

    var observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        mutation.addedNodes.forEach(function (node) {
          if (node.nodeType !== 1) return;
          if (node.classList && node.classList.contains('product-card')) {
            scheduleAnimation(node);
          } else {
            // Cards might be nested
            var cards = node.querySelectorAll && node.querySelectorAll('.product-card');
            if (cards) cards.forEach(scheduleAnimation);
          }
        });
      });
    });

    observer.observe(grid, { childList: true, subtree: true });
  })();

  // ────────────────────────────────────────────────────────────────────────────
  // 5. PRODUCT CARD HOVER — subtle 3D tilt
  // ────────────────────────────────────────────────────────────────────────────
  (function initCardTilt() {
    var MAX_TILT = 4; // degrees

    document.addEventListener('mousemove', function (e) {
      var card = e.target.closest('.product-card');
      if (!card) return;

      var rect    = card.getBoundingClientRect();
      var centerX = rect.left + rect.width  / 2;
      var centerY = rect.top  + rect.height / 2;
      var rotateY =  ((e.clientX - centerX) / (rect.width  / 2)) * MAX_TILT;
      var rotateX = -((e.clientY - centerY) / (rect.height / 2)) * MAX_TILT;

      gsap.to(card, {
        rotateX: rotateX,
        rotateY: rotateY,
        transformPerspective: 800,
        duration: 0.3,
        ease: 'power1.out',
        overwrite: 'auto',
      });
    });

    document.addEventListener('mouseleave', function (e) {
      var card = e.target.closest && e.target.closest('.product-card');
      if (!card) return;
      gsap.to(card, {
        rotateX: 0,
        rotateY: 0,
        duration: 0.5,
        ease: EASE_BACK,
        overwrite: 'auto',
      });
    }, true);
  })();

  // ────────────────────────────────────────────────────────────────────────────
  // 6. NEZ INVITE BLOCK — pulse + float animation on the button
  // ────────────────────────────────────────────────────────────────────────────
  (function initNezInvite() {
    var btn = document.querySelector('.hero-som-btn');
    if (!btn) return;

    // Subtle floating loop
    gsap.to(btn, {
      y: -5,
      duration: 2.2,
      ease: 'sine.inOut',
      yoyo: true,
      repeat: -1,
      delay: 2,
    });

    // Glow pulse on the divider line
    var divider = document.querySelector('.hero-som-divider');
    if (divider) {
      gsap.to(divider, {
        opacity: 0.4,
        duration: 1.8,
        ease: 'sine.inOut',
        yoyo: true,
        repeat: -1,
      });
    }
  })();

  // ────────────────────────────────────────────────────────────────────────────
  // 7. FOOTER — fade in on scroll
  // ────────────────────────────────────────────────────────────────────────────
  (function initFooter() {
    var footer = document.querySelector('footer');
    if (!footer) return;

    gsap.from(footer, {
      opacity: 0,
      y: 30,
      duration: DURATION,
      ease: EASE_OUT,
      scrollTrigger: {
        trigger: footer,
        start:   'top 95%',
        once:    true,
      },
    });
  })();

  // ────────────────────────────────────────────────────────────────────────────
  // 8. SMOOTH SCROLL for anchor links (overrides CSS scroll-behavior for control)
  // ────────────────────────────────────────────────────────────────────────────
  (function initSmoothScroll() {
    document.querySelectorAll('a[href^="#"]').forEach(function (link) {
      link.addEventListener('click', function (e) {
        var target = document.querySelector(this.getAttribute('href'));
        if (!target) return;
        e.preventDefault();
        gsap.to(window, {
          scrollTo: { y: target, offsetY: 60 },
          duration: 1,
          ease: 'power3.inOut',
        });
      });
    });
  })();

})();
