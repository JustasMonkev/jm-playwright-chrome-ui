// The opening move of every hash-routed extension popup: rewrite the URL to a route, so the
// live document no longer matches the URL the manifest declares.
if (!location.hash)
  location.replace(`${location.pathname}#/home`);
