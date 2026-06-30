/* Shell interactions for the app frame.
   Purely additive — it never touches app.js state or its render pipeline.
   Responsibilities:
     1. Side-rail tab switching (Layers / Build Notes)
     2. Dismissing <details class="menu"> popovers on outside-click / item-click
     3. Closing overlay panels when their backdrop is clicked
        (delegates to the panel's existing control so app.js state stays in sync)
*/
(function () {
  "use strict";

  function ready(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn, { once: true });
    } else {
      fn();
    }
  }

  ready(function () {
    // 1. Side-rail tabs ----------------------------------------------------
    const tabs = Array.from(document.querySelectorAll(".rail-tab"));
    const panes = Array.from(document.querySelectorAll(".rail-pane"));

    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        const target = tab.dataset.railTab;
        tabs.forEach(function (t) {
          t.classList.toggle("is-active", t === tab);
        });
        panes.forEach(function (pane) {
          pane.classList.toggle("hidden", pane.dataset.railPane !== target);
        });
      });
    });

    // 2. Disclosure menu dismissal ----------------------------------------
    document.addEventListener("click", function (event) {
      const openMenus = document.querySelectorAll("details.menu[open]");
      openMenus.forEach(function (menu) {
        const clickedInside = menu.contains(event.target);
        if (!clickedInside) {
          menu.open = false;
          return;
        }
        // Clicking an actual item inside the panel closes the menu too.
        const panel = event.target.closest(".menu-panel");
        if (panel && event.target.closest("button")) {
          menu.open = false;
        }
      });
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        document.querySelectorAll("details.menu[open]").forEach(function (menu) {
          menu.open = false;
        });
      }
    });

    // 3. Overlay backdrop closes via the panel's existing control ----------
    const overlayClosers = {
      projectShelf: "closeProjectShelfBtn",
      collectionGridPanel: "closeCollectionGridBtn",
      fitDebugPanel: "toggleFitDebugBtn"
    };

    Object.keys(overlayClosers).forEach(function (panelId) {
      const panel = document.getElementById(panelId);
      if (!panel) return;
      panel.addEventListener("click", function (event) {
        // Only when the click lands on the backdrop itself, not its card.
        if (event.target === panel) {
          const closer = document.getElementById(overlayClosers[panelId]);
          if (closer) closer.click();
        }
      });
    });
  });
})();
