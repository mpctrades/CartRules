// CartRules — shared site behavior

document.addEventListener("DOMContentLoaded", () => {
  /* ---------- mobile nav toggle ---------- */
  const nav = document.querySelector(".nav");
  const navToggle = document.querySelector(".nav__toggle");
  if (nav && navToggle) {
    navToggle.addEventListener("click", () => {
      const isOpen = nav.classList.toggle("is-open");
      navToggle.setAttribute("aria-expanded", String(isOpen));
    });
    nav.querySelectorAll(".nav__mobile a").forEach((link) => {
      link.addEventListener("click", () => nav.classList.remove("is-open"));
    });
  }

  /* ---------- FAQ accordion ---------- */
  document.querySelectorAll(".faq-item").forEach((item) => {
    const btn = item.querySelector(".faq-q");
    const answer = item.querySelector(".faq-a");
    if (!btn || !answer) return;

    btn.addEventListener("click", () => {
      const isOpen = item.classList.contains("is-open");

      // close others in the same list for a clean single-open accordion
      const list = item.closest(".faq-list");
      if (list) {
        list.querySelectorAll(".faq-item.is-open").forEach((openItem) => {
          if (openItem !== item) {
            openItem.classList.remove("is-open");
            const a = openItem.querySelector(".faq-a");
            if (a) a.style.maxHeight = "0px";
            const b = openItem.querySelector(".faq-q");
            if (b) b.setAttribute("aria-expanded", "false");
          }
        });
      }

      if (isOpen) {
        item.classList.remove("is-open");
        answer.style.maxHeight = "0px";
        btn.setAttribute("aria-expanded", "false");
      } else {
        item.classList.add("is-open");
        answer.style.maxHeight = answer.scrollHeight + "px";
        btn.setAttribute("aria-expanded", "true");
      }
    });
  });

  /* ---------- highlight current nav link on index.html sections ---------- */
  const sections = document.querySelectorAll("main section[id]");
  const navLinks = document.querySelectorAll(".nav__links a[href^='#'], .nav__mobile a[href^='#']");
  if (sections.length && navLinks.length && "IntersectionObserver" in window) {
    const byId = (id) =>
      document.querySelectorAll(`.nav__links a[href='#${id}'], .nav__mobile a[href='#${id}']`);

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            navLinks.forEach((l) => l.classList.remove("is-active"));
            byId(entry.target.id).forEach((l) => l.classList.add("is-active"));
          }
        });
      },
      { rootMargin: "-40% 0px -50% 0px", threshold: 0 }
    );
    sections.forEach((s) => observer.observe(s));
  }

  /* ---------- guide.html: sidebar TOC scrollspy + mobile select ---------- */
  const tocLinks = document.querySelectorAll(".guide-toc a[href^='#']");
  const tocSelect = document.querySelector(".guide-toc-select");
  const guideSections = document.querySelectorAll(".g-section[id]");

  if (tocSelect) {
    tocSelect.addEventListener("change", (e) => {
      const target = document.getElementById(e.target.value);
      if (target) target.scrollIntoView({ behavior: "smooth" });
    });
  }

  if (guideSections.length && "IntersectionObserver" in window) {
    const setActive = (id) => {
      tocLinks.forEach((l) => l.classList.toggle("is-active", l.getAttribute("href") === `#${id}`));
      if (tocSelect && tocSelect.value !== id) tocSelect.value = id;
    };

    const spy = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) setActive(entry.target.id);
        });
      },
      { rootMargin: "-15% 0px -70% 0px", threshold: 0 }
    );
    guideSections.forEach((s) => spy.observe(s));
  }

  /* ---------- support contact form: build a pre-filled mailto ---------- */
  const supportForm = document.getElementById("support-form");
  if (supportForm) {
    supportForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const data = new FormData(supportForm);
      const name = (data.get("name") || "").toString().trim();
      const email = (data.get("email") || "").toString().trim();
      const store = (data.get("store") || "").toString().trim();
      const topic = (data.get("topic") || "").toString().trim();
      const message = (data.get("message") || "").toString().trim();

      const subject = `CartRules support — ${topic}`;
      const bodyLines = [
        `Name: ${name}`,
        `Email: ${email}`,
        store ? `Store: ${store}` : null,
        "",
        message,
      ].filter((line) => line !== null);

      const mailto =
        "mailto:team@mpctrades.com" +
        `?subject=${encodeURIComponent(subject)}` +
        `&body=${encodeURIComponent(bodyLines.join("\n"))}`;

      window.location.href = mailto;
    });
  }

  /* ---------- motion: respects prefers-reduced-motion throughout ---------- */
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* scroll progress bar */
  const progressBar = document.querySelector(".scroll-progress > span");
  if (progressBar) {
    const updateProgress = () => {
      const scrollTop = window.scrollY;
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      const pct = docHeight > 0 ? Math.min((scrollTop / docHeight) * 100, 100) : 0;
      progressBar.style.width = pct + "%";
    };
    updateProgress();
    window.addEventListener("scroll", updateProgress, { passive: true });
    window.addEventListener("resize", updateProgress);
  }

  /* nav shadow state on scroll */
  if (nav) {
    const onNavScroll = () => nav.classList.toggle("is-scrolled", window.scrollY > 20);
    onNavScroll();
    window.addEventListener("scroll", onNavScroll, { passive: true });
  }

  /* gentle continuous float on the hero mockup, once its entrance finishes */
  const heroMockup = document.querySelector(".hero .mockup");
  if (heroMockup && !prefersReducedMotion) {
    heroMockup.classList.add("is-floating");
  }

  /* scroll-reveal: fade + slide up as sections enter the viewport, staggered within grids */
  const revealSelectors = [
    ".section-head",
    ".card",
    ".howit-step",
    ".wizard",
    ".guide-cta",
    ".table-scroll",
    ".plan",
    ".roadmap-card",
    ".faq-item",
    ".contact-card",
    ".g-block",
    ".recipe-card",
    ".trouble-item",
    ".help-box",
  ];
  const revealEls = document.querySelectorAll(revealSelectors.join(","));

  if (revealEls.length) {
    const staggerGroups = document.querySelectorAll(
      ".grid-3, .grid-4, .pricing-grid, .roadmap-grid, .howit-steps, .recipe-grid, .faq-list, .trouble-list"
    );
    staggerGroups.forEach((group) => {
      Array.from(group.children).forEach((child, i) => {
        child.style.transitionDelay = `${Math.min(i, 6) * 70}ms`;
      });
    });

    revealEls.forEach((el) => el.classList.add("reveal"));

    if (prefersReducedMotion || !("IntersectionObserver" in window)) {
      revealEls.forEach((el) => el.classList.add("is-visible"));
    } else {
      const revealObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              entry.target.classList.add("is-visible");
              revealObserver.unobserve(entry.target);
            }
          });
        },
        { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
      );
      revealEls.forEach((el) => revealObserver.observe(el));
    }
  }

  /* animated count-up for the hero dashboard stats */
  const statVals = document.querySelectorAll(".mockup__stat .val");
  if (statVals.length && "IntersectionObserver" in window) {
    const animateCount = (el, duration = 900) => {
      const text = el.textContent.trim();
      const target = parseInt(text.replace(/[^0-9]/g, ""), 10);
      if (Number.isNaN(target)) return;
      const prefix = text.match(/^[^0-9]*/)[0];
      const suffix = text.match(/[^0-9]*$/)[0];
      const start = performance.now();
      const tick = (now) => {
        const p = Math.min((now - start) / duration, 1);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = `${prefix}${Math.round(target * eased)}${suffix}`;
        if (p < 1) requestAnimationFrame(tick);
        else el.textContent = `${prefix}${target}${suffix}`;
      };
      requestAnimationFrame(tick);
    };

    if (prefersReducedMotion) {
      // leave final values as authored
    } else {
      const seen = new WeakSet();
      const statObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting && !seen.has(entry.target)) {
              seen.add(entry.target);
              animateCount(entry.target);
            }
          });
        },
        { threshold: 0.4 }
      );
      statVals.forEach((el) => statObserver.observe(el));
    }
  }

  /* cursor-spotlight glow on the contact card */
  const contactCard = document.querySelector(".contact-card");
  if (contactCard && !prefersReducedMotion) {
    contactCard.addEventListener("mousemove", (e) => {
      const rect = contactCard.getBoundingClientRect();
      contactCard.style.setProperty("--x", `${e.clientX - rect.left}px`);
      contactCard.style.setProperty("--y", `${e.clientY - rect.top}px`);
    });
  }
});
