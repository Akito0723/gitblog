/**
 * @param {MediaQueryList} mqList
 * @param {((this: MediaQueryList, ev: MediaQueryListEvent) => any)} listener
 */
function observeMediaChange(mqList, listener) {
  let disposeFunc = () => {};
  if (mqList.addEventListener && mqList.removeEventListener) {
    mqList.addEventListener("change", listener);

    disposeFunc = () => {
      mqList.removeEventListener("change", listener);
    };
  } else if (mqList.addListener && mqList.removeListener) {
    mqList.addListener(listener);

    disposeFunc = () => {
      mqList.removeListener(listener);
    };
  }

  return disposeFunc;
}

function checkIsDarkMode() {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch (err) {
    return false;
  }
}

function switchThemeMode(mode) {
  /** @type {HTMLLinkElement} */
  const link = document.querySelector("link#theme");
  if (!link) {
    return;
  }

  const nextMode = getThemeUrl(link, mode, "cdn");
  const fallbackMode = getThemeUrl(link, mode, "local");
  link.onerror = () => {
    link.onerror = null;
    link.href = fallbackMode;
  };

  if (link.getAttribute("href") !== nextMode) {
    link.href = nextMode;
  }
}

function getThemeUrl(link, mode, source) {
  const themeMode = mode === "dark" ? "dark" : "light";
  const datasetKey =
    source === "local"
      ? `local${capitalize(themeMode)}`
      : `cdn${capitalize(themeMode)}`;

  return link.dataset[datasetKey] || link.dataset.cdnLight || link.href;
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

if (checkIsDarkMode()) {
  switchThemeMode("dark");
}

var mqList = window.matchMedia("(prefers-color-scheme: dark)");

observeMediaChange(mqList, (event) => {
  // is dark mode
  if (event.matches) {
    console.log("switch to dark mode");
    switchThemeMode("dark");
  } else {
    console.log("switch to light mode");
    switchThemeMode("light");
  }
});
