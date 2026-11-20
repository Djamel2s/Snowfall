/* Kit de maquettes Snowfall : moteur. Lit le HTML écrit par le modèle (bloc
   <script type="application/json" id="sf-source">), le NETTOIE (aucun script,
   aucun attribut on…, aucun lien javascript:), le place dans un appareil
   (mobile ou ordinateur), puis donne vie aux attributs du kit :
     data-screen / data-go / data-back   écrans et navigation
     data-open / data-close              fenêtres (modal, sheet)
     data-tab / data-panel               onglets
     data-toggle, .switch                interrupteurs et filtres
     data-toast                          message éphémère
     data-icon                           icônes dessinées ici (aucun chargement)
   Seul ce script s'exécute : celui du modèle est retiré avant affichage. */
(function () {
  "use strict";

  var ICONS = {
    home: "M3 11 12 4l9 7M5 10v10h5v-6h4v6h5V10",
    search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
    user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5",
    users: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c1-3 3.5-4.5 6.5-4.5s5.5 1.5 6.5 4.5M16 4.5a3.5 3.5 0 0 1 0 6.5M18 15.5c2 .6 3.2 2 3.8 4.5",
    settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12l2-1-1-3-2.2.3-1.3-1.3L16.8 5l-3-1-1 2h-1.6l-1-2-3 1 .3 2.2L7 8.5 4.8 8.2l-1 3 2 1v1.6l-2 1 1 3 2.2-.3 1.3 1.3-.3 2.2 3 1 1-2h1.6l1 2 3-1-.3-2.2 1.3-1.3 2.2.3 1-3-2-1z",
    bell: "M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0",
    plus: "M12 5v14M5 12h14",
    check: "M5 12.5 10 17 19 7",
    x: "M6 6l12 12M18 6 6 18",
    "chevron-right": "M9 5l7 7-7 7",
    "chevron-left": "M15 5l-7 7 7 7",
    "chevron-down": "M5 9l7 7 7-7",
    "arrow-left": "M19 12H5M11 6l-6 6 6 6",
    "arrow-right": "M5 12h14M13 6l6 6-6 6",
    menu: "M4 6h16M4 12h16M4 18h16",
    heart: "M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z",
    star: "M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8L3.5 9.7l5.9-.8z",
    calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
    chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
    mail: "M3 6h18v12H3zM3 7l9 6 9-6",
    phone: "M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z",
    lock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
    cart: "M3 4h2.5l2.2 11h10.6l2-8H7M9 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM18 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
    file: "M7 3h7l5 5v13H7zM14 3v5h5",
    folder: "M3 6h6l2 2h10v11H3z",
    "map-pin": "M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
    camera: "M4 8h3l2-3h6l2 3h3v11H4zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z",
    message: "M4 5h16v11H9l-5 4z",
    filter: "M4 5h16l-6 8v6l-4-2v-4z",
    edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
    trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
    logout: "M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10",
    upload: "M12 16V4M7 9l5-5 5 5M4 20h16",
    download: "M12 4v12M7 11l5 5 5-5M4 20h16",
    clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
    eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5v.5",
    sparkles: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z",
  };
  var SVG = "http://www.w3.org/2000/svg";

  function icon(name) {
    var svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "sf-icon");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    var path = document.createElementNS(SVG, "path");
    path.setAttribute("d", ICONS[name] || ICONS.info);
    svg.appendChild(path);
    return svg;
  }

  // ---- Nettoyage du HTML du modèle ---------------------------------------------------
  var DROP = "script,iframe,frame,frameset,object,embed,applet,link,meta,base,noscript,template,portal";
  // Une maquette ne charge rien : seule une image intégrée (data:image/…) est gardée.
  var RESOURCE_ATTRIBUTES = ["src", "srcset", "poster", "background", "xlink:href", "data"];

  function embeddedImage(value) {
    return /^data:image\/(png|jpe?g|gif|webp);/.test(String(value).replace(/[\u0000-\u0020]+/g, "").toLowerCase());
  }

  // Styles du modèle : ni @import, ni url() vers l'extérieur (une image distante pisterait).
  function cleanCss(text) {
    return String(text)
      .replace(/@import[^;]*;?/gi, "")
      .replace(/url\(\s*(['"]?)(?!data:image\/)[^)]*\)/gi, "none");
  }

  function sanitize(root) {
    var dropped = root.querySelectorAll(DROP);
    for (var i = 0; i < dropped.length; i++) dropped[i].remove();
    var all = root.querySelectorAll("*");
    for (var j = 0; j < all.length; j++) {
      var element = all[j];
      var attributes = Array.prototype.slice.call(element.attributes);
      for (var k = 0; k < attributes.length; k++) {
        var name = attributes[k].name.toLowerCase();
        var value = attributes[k].value;
        var drop =
          name.indexOf("on") === 0 ||
          name === "srcdoc" ||
          name === "action" ||
          name === "formaction" ||
          name === "ping" ||
          (RESOURCE_ATTRIBUTES.indexOf(name) !== -1 && !embeddedImage(value)) ||
          // Lien : seulement une ancre de la maquette (#ecran) ; une image SVG, seulement intégrée.
          (name === "href" && !/^#[\w-]*$/.test(value.trim()) && !(element.tagName.toLowerCase() === "image" && embeddedImage(value)));
        if (drop) element.removeAttribute(attributes[k].name);
        else if (name === "style") element.setAttribute("style", cleanCss(value));
      }
      // Une animation SVG peut réécrire un lien (<set attributeName="href" to="javascript:…">).
      var tag = element.tagName.toLowerCase();
      if ((tag === "set" || tag === "animate") && /href/i.test(element.getAttribute("attributeName") || "")) element.remove();
    }
    return root;
  }

  // ---- Montage -------------------------------------------------------------------------
  var source = "";
  try {
    source = JSON.parse(document.getElementById("sf-source").textContent || '""');
  } catch (error) {
    source = "";
  }
  var parsed = new DOMParser().parseFromString(String(source), "text/html");
  sanitize(parsed.documentElement);

  var styles = parsed.querySelectorAll("style");
  for (var s = 0; s < styles.length; s++) {
    var style = document.createElement("style");
    style.textContent = cleanCss(styles[s].textContent);
    document.head.appendChild(style);
  }
  for (var r = 0; r < styles.length; r++) styles[r].remove();

  var app = parsed.body.querySelector(".app");
  if (!app) {
    app = parsed.createElement("div");
    app.className = "app";
    while (parsed.body.firstChild) app.appendChild(parsed.body.firstChild);
  }
  app = document.importNode(app, true);

  var accent = app.getAttribute("data-accent");
  if (accent && /^#[0-9a-f]{6}$/i.test(accent)) {
    document.documentElement.style.setProperty("--accent", accent);
    var value = parseInt(accent.slice(1), 16);
    var light = 0.299 * ((value >> 16) & 255) + 0.587 * ((value >> 8) & 255) + 0.114 * (value & 255) > 165;
    document.documentElement.style.setProperty("--accent-ink", light ? "#111827" : "#ffffff");
  }

  var stage = document.createElement("div");
  stage.className = "sf-stage";
  var device = document.createElement("div");
  device.className = "sf-device";
  var wanted = app.getAttribute("data-device");
  device.setAttribute("data-device", wanted === "desktop" || wanted === "mobile" ? wanted : app.querySelector(".sidebar") ? "desktop" : "mobile");
  var viewport = document.createElement("div");
  viewport.className = "sf-viewport";
  viewport.appendChild(app);
  device.appendChild(viewport);
  stage.appendChild(device);
  document.body.appendChild(stage);

  var holders = app.querySelectorAll("[data-icon]");
  for (var h = 0; h < holders.length; h++) {
    var holder = holders[h];
    var name = holder.getAttribute("data-icon");
    if (holder.tagName.toLowerCase() === "i" || !holder.childNodes.length) holder.replaceWith(icon(name));
    else holder.insertBefore(icon(name), holder.firstChild);
  }

  // ---- Écrans ------------------------------------------------------------------------
  var screens = Array.prototype.slice.call(app.querySelectorAll("[data-screen]"));
  if (!screens.length) {
    var only = document.createElement("section");
    only.className = "screen";
    only.setAttribute("data-screen", "accueil");
    while (app.firstChild) only.appendChild(app.firstChild);
    app.appendChild(only);
    screens = [only];
  }
  var history = [];
  var current = null;
  var select = null;

  function titleOf(screen) {
    var heading = screen.querySelector("h1, .title");
    return screen.getAttribute("data-title") || (heading && heading.textContent.trim()) || screen.getAttribute("data-screen");
  }

  function go(id, remember) {
    var target = null;
    for (var i = 0; i < screens.length; i++) if (screens[i].getAttribute("data-screen") === id) target = screens[i];
    if (!target || target === current) return;
    if (current && remember !== false) history.push(current.getAttribute("data-screen"));
    for (var j = 0; j < screens.length; j++) screens[j].classList.toggle("sf-active", screens[j] === target);
    current = target;
    viewport.scrollTop = 0;
    var links = app.querySelectorAll("[data-go]");
    for (var k = 0; k < links.length; k++) {
      if (links[k].getAttribute("data-go") === id) links[k].setAttribute("aria-current", "page");
      else links[k].removeAttribute("aria-current");
    }
    if (select) select.value = id;
  }

  var start = app.querySelector("[data-screen][data-start]") || screens[0];
  go(start.getAttribute("data-screen"), false);

  // ---- Comportements -----------------------------------------------------------------
  function toast(text) {
    var old = viewport.parentNode.querySelector(".sf-toast");
    if (old) old.remove();
    var note = document.createElement("div");
    note.className = "sf-toast";
    note.setAttribute("role", "status");
    note.textContent = text;
    device.appendChild(note);
    setTimeout(function () { note.remove(); }, 2200);
  }

  function openWindow(id) {
    var target = app.querySelector("#" + CSS.escape(id));
    if (target) target.classList.add("sf-open");
  }

  app.addEventListener("click", function (event) {
    var target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    var opened = target.closest(".modal.sf-open, .sheet.sf-open");
    if (opened && target === opened) return opened.classList.remove("sf-open");
    var closer = target.closest("[data-close]");
    if (closer) {
      var parent = closer.closest(".modal, .sheet");
      if (parent) parent.classList.remove("sf-open");
    }
    var tab = target.closest("[data-tab]");
    if (tab) {
      var group = tab.closest(".tabs");
      var scope = (group && group.parentElement) || app;
      var tabs = group ? group.querySelectorAll("[data-tab]") : [tab];
      for (var i = 0; i < tabs.length; i++) tabs[i].setAttribute("aria-selected", tabs[i] === tab ? "true" : "false");
      var panels = scope.querySelectorAll("[data-panel]");
      for (var j = 0; j < panels.length; j++) panels[j].hidden = panels[j].getAttribute("data-panel") !== tab.getAttribute("data-tab");
    }
    var toggle = target.closest(".switch, [data-toggle]");
    if (toggle) {
      var attribute = toggle.classList.contains("switch") ? "aria-checked" : "aria-pressed";
      toggle.setAttribute(attribute, toggle.getAttribute(attribute) === "true" ? "false" : "true");
    }
    var opener = target.closest("[data-open]");
    if (opener) openWindow(opener.getAttribute("data-open"));
    var message = target.closest("[data-toast]");
    if (message) toast(message.getAttribute("data-toast"));
    if (target.closest("[data-back]")) go(history.pop() || screens[0].getAttribute("data-screen"), false);
    var link = target.closest("[data-go]");
    if (link && link.tagName.toLowerCase() !== "form") go(link.getAttribute("data-go"));
    // Un lien de maquette ne quitte jamais la maquette.
    var anchor = target.closest("a");
    if (anchor) {
      event.preventDefault();
      var hash = (anchor.getAttribute("href") || "").replace(/^#/, "");
      if (hash && !link) go(hash);
    }
  });

  app.addEventListener("submit", function (event) {
    event.preventDefault();
    var form = event.target;
    if (form.getAttribute("data-toast")) toast(form.getAttribute("data-toast"));
    if (form.getAttribute("data-go")) go(form.getAttribute("data-go"));
  });

  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    var opened = app.querySelectorAll(".sf-open");
    for (var i = 0; i < opened.length; i++) opened[i].classList.remove("sf-open");
  });

  // ---- Barre d'outils : écran affiché, appareil ---------------------------------------
  var toolbar = document.createElement("div");
  toolbar.className = "sf-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Maquette");
  if (screens.length > 1) {
    select = document.createElement("select");
    select.setAttribute("aria-label", "Écran");
    for (var o = 0; o < screens.length; o++) {
      var option = document.createElement("option");
      option.value = screens[o].getAttribute("data-screen");
      option.textContent = titleOf(screens[o]);
      select.appendChild(option);
    }
    select.value = current.getAttribute("data-screen");
    select.addEventListener("change", function () { go(select.value); });
    toolbar.appendChild(select);
  }
  [["mobile", "Mobile"], ["desktop", "Ordinateur"]].forEach(function (choice) {
    var button = document.createElement("button");
    button.type = "button";
    button.textContent = choice[1];
    button.setAttribute("data-device", choice[0]);
    button.setAttribute("aria-pressed", device.getAttribute("data-device") === choice[0] ? "true" : "false");
    button.addEventListener("click", function () {
      device.setAttribute("data-device", choice[0]);
      var buttons = toolbar.querySelectorAll("button[data-device]");
      for (var b = 0; b < buttons.length; b++) buttons[b].setAttribute("aria-pressed", buttons[b] === button ? "true" : "false");
    });
    toolbar.appendChild(button);
  });
  document.body.appendChild(toolbar);

  // Ordinateur : la fenêtre simulée garde sa vraie largeur et se réduit à l'échelle
  // (miniature fidèle) ; sa hauteur remplit l'espace disponible.
  function fit() {
    if (device.getAttribute("data-device") !== "desktop") {
      device.style.transform = device.style.height = device.style.marginBottom = "";
      return;
    }
    var scale = Math.min(1, (stage.clientWidth - 32) / 1200);
    var height = Math.max(480, (window.innerHeight - 80) / scale);
    device.style.transform = "scale(" + scale + ")";
    device.style.height = height + "px";
    device.style.marginBottom = -(1 - scale) * height + "px";
  }
  window.addEventListener("resize", fit);
  toolbar.addEventListener("click", function () { setTimeout(fit, 0); });
  fit();
  document.documentElement.setAttribute("data-sf-ready", "true");
})();
