// Theme switcher: light, dark or automatic screen colours, shared by every Kin-bill page.
// Loaded in <head> as a plain script (not a module) so the right colours apply before the page is drawn.
// Auto follows the device setting (prefers-color-scheme) and is the default; Light and Dark are fixed.
// The choice is remembered on this device. Any element with [data-theme-switch] gets the three buttons,
// and other scripts can use window.KinbillTheme or listen for the "kinbill:theme" event.

(function () {
  var KEY = 'kinbill-theme';
  // Each button has a short visible label and a fuller name for screen readers.
  var CHOICES = [
    { value: 'system', label: 'Auto', name: 'Automatic, same as this device' },
    { value: 'light', label: 'Light', name: 'Light screen' },
    { value: 'dark', label: 'Dark', name: 'Dark screen' },
  ];
  // Watched so that Auto can follow the device when it switches between light and dark.
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  // Saved choice, or 'system'. localStorage can throw (private mode, blocked storage), so fall back safely.
  function read() {
    try { return localStorage.getItem(KEY) || 'system'; } catch (e) { return 'system'; }
  }
  // Saves the choice on this device so it stays the same on every visit.
  function write(value) {
    try { localStorage.setItem(KEY, value); } catch (e) { /* private mode: fine */ }
  }

  /**
   * Applies a theme choice to the page and tells other scripts about it.
   * @param {string} choice  'system', 'light' or 'dark'
   */
  function apply(choice) {
    var root = document.documentElement;
    // Without data-theme, styles.css follows the device setting on its own.
    if (choice === 'light' || choice === 'dark') root.setAttribute('data-theme', choice);
    else root.removeAttribute('data-theme');
    var dark = choice === 'dark' || (choice === 'system' && !!(media && media.matches));
    // data-mode always holds the colours in use, even on Auto, so scripts can read one attribute.
    root.setAttribute('data-mode', dark ? 'dark' : 'light');
    root.setAttribute('data-ag-theme-mode', dark ? 'dark' : 'light'); // David's tables (AG Grid) follow too
    document.dispatchEvent(new CustomEvent('kinbill:theme', { detail: { choice: choice, mode: dark ? 'dark' : 'light' } }));
  }

  /**
   * Draws the Auto / Light / Dark buttons inside every [data-theme-switch] element.
   * Each group is labelled "Screen", and aria-pressed tells screen readers which button is chosen.
   */
  function render() {
    var current = read();
    var holders = document.querySelectorAll('[data-theme-switch]');
    for (var i = 0; i < holders.length; i++) {
      var holder = holders[i];
      var id = 'theme-label-' + i; // unique per group, because a page can have more than one switch
      holder.innerHTML = '';
      holder.classList.add('group');
      holder.setAttribute('role', 'group');
      holder.setAttribute('aria-labelledby', id);
      var label = document.createElement('span');
      label.className = 'group-label';
      label.id = id;
      label.textContent = 'Screen';
      holder.appendChild(label);
      CHOICES.forEach(function (c) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = c.label;
        b.setAttribute('aria-label', c.name);
        b.setAttribute('aria-pressed', String(c.value === current));
        b.addEventListener('click', function () { set(c.value); });
        holder.appendChild(b);
      });
    }
  }

  /**
   * Saves a new choice, applies it, and redraws the buttons so the pressed state is right.
   * @param {string} value  'system', 'light' or 'dark'
   */
  function set(value) {
    write(value);
    apply(value);
    render();
  }

  // Apply the colours straight away, before the page is drawn, to avoid a flash of the wrong theme.
  apply(read());
  if (media) {
    // A device change only matters when the choice is Auto.
    var onChange = function () { if (read() === 'system') apply('system'); };
    // addListener is the older form, for browsers without addEventListener on media queries.
    if (media.addEventListener) media.addEventListener('change', onChange);
    else if (media.addListener) media.addListener(onChange);
  }
  // The buttons need the page body, so they are drawn once it has loaded.
  document.addEventListener('DOMContentLoaded', render);

  // Small public API for other scripts: read the choice, change it, or get the colours in use.
  window.KinbillTheme = {
    get: read,
    set: set,
    mode: function () { return document.documentElement.getAttribute('data-mode') || 'light'; },
  };
})();
