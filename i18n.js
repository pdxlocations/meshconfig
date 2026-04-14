// i18n.js - lightweight vanilla i18n with auto-detection
const i18n = (() => {
  const translations = {};
  let currentLang = "en";
  let fallbackLang = "en";
  let path = "/i18n"; // folder where JSON files live
  const supportedLangs = ["en", "pt", "es"]; // adjust as needed

  // Normalize language code
  function normalizeLang(lang) {
    if (!lang) return fallbackLang;
    const short = lang.toLowerCase().split("-")[0];
    return supportedLangs.includes(short) ? short : fallbackLang;
  }

  // Detect language (URL -> localStorage -> browser -> fallback)
  function detectLanguage() {
    const params = new URLSearchParams(window.location.search);
    const urlLang = params.get("lang");
    if (urlLang) {
      localStorage.setItem("lang", urlLang);
      return normalizeLang(urlLang);
    }

    const saved = localStorage.getItem("lang");
    if (saved) return normalizeLang(saved);

    const browser = navigator.language || navigator.userLanguage;
    return normalizeLang(browser);
  }

  // Load language JSON
  async function loadLanguage(lang) {
    const normalized = normalizeLang(lang);
    if (!translations[normalized]) {
      try {
        const res = await fetch(`${path}/${normalized}.json`);
        if (!res.ok) throw new Error(`Missing ${normalized}.json`);
        translations[normalized] = await res.json();
      } catch (e) {
        console.warn(`i18n: failed to load ${normalized}, falling back`);
        if (normalized !== fallbackLang) return loadLanguage(fallbackLang);
        return;
      }
    }

    currentLang = normalized;
    localStorage.setItem("lang", currentLang);
    updateDOM();
  }

  // Get nested translation
  function getNested(obj, key) {
    return key.split('.').reduce((o, i) => o?.[i], obj);
  }

  // Translate function
  function t(key, vars = {}) {
    let str =
      getNested(translations[currentLang], key) ??
      getNested(translations[fallbackLang], key) ??
      key;

    // Replace {{var}}
    Object.keys(vars).forEach(k => {
      str = str.replace(new RegExp(`{{\\s*${k}\\s*}}`, "g"), vars[k]);
    });

    return str;
  }

  // Update DOM
  function updateDOM() {
    document.querySelectorAll("[data-i18n]").forEach(el => {
      const key = el.getAttribute("data-i18n");
      el.innerText = t(key);
    });

    document.querySelectorAll("[data-i18n-attr]").forEach(el => {
      const attrMap = el.getAttribute("data-i18n-attr").split(";");
      attrMap.forEach(pair => {
        const [attr, key] = pair.split(":");
        if (attr && key) el.setAttribute(attr.trim(), t(key.trim()));
      });
    });
  }

  // Init system
  async function init(options = {}) {
    if (options.path) path = options.path;
    if (options.fallback) fallbackLang = options.fallback;
    const lang = options.lang || detectLanguage();
    await loadLanguage(lang);
  }

  return {
    init,
    t,
    setLang: loadLanguage,
    getLang: () => currentLang,
  };
})();

window.i18n = i18n;