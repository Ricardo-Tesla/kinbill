// Light / dark / automatic screen theme, shared by every page.
// Loaded in <head> (not as a module) so the right colours apply before the page is drawn.
//
//   Auto  = follow the device setting (prefers-color-scheme), the default
//   Light = always light
//   Dark  = always dark
//
// The choice is remembered on this device. Any element with [data-theme-switch]
// gets the three buttons. Other scripts can listen for the "kinbill:theme" event.

(function () {
  var KEY = 'kinbill-theme';
  var CHOICES = [
    { value: 'system', label: 'Auto', name: 'Automatic, same as this device' },
    { value: 'light', label: 'Light', name: 'Light screen' },
    { value: 'dark', label: 'Dark', name: 'Dark screen' },
  ];
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function read() {
    try { return localStorage.getItem(KEY) || 'system'; } catch (e) { return 'system'; }
  }
  function write(value) {
    try { localStorage.setItem(KEY, value); } catch (e) { /* private mode: fine */ }
  }

  function apply(choice) {
    var root = document.documentElement;
    if (choice === 'light' || choice === 'dark') root.setAttribute('data-theme', choice);
    else root.removeAttribute('data-theme');
    var dark = choice === 'dark' || (choice === 'system' && !!(media && media.matches));
    root.setAttribute('data-mode', dark ? 'dark' : 'light');
    root.setAttribute('data-ag-theme-mode', dark ? 'dark' : 'light'); // David's tables (AG Grid) follow too
    document.dispatchEvent(new CustomEvent('kinbill:theme', { detail: { choice: choice, mode: dark ? 'dark' : 'light' } }));
  }

  function render() {
    var current = read();
    var holders = document.querySelectorAll('[data-theme-switch]');
    for (var i = 0; i < holders.length; i++) {
      var holder = holders[i];
      var id = 'theme-label-' + i;
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

  function set(value) {
    write(value);
    apply(value);
    render();
  }

  apply(read());
  if (media) {
    var onChange = function () { if (read() === 'system') apply('system'); };
    if (media.addEventListener) media.addEventListener('change', onChange);
    else if (media.addListener) media.addListener(onChange);
  }
  document.addEventListener('DOMContentLoaded', render);

  window.KinbillTheme = {
    get: read,
    set: set,
    mode: function () { return document.documentElement.getAttribute('data-mode') || 'light'; },
  };
})();
