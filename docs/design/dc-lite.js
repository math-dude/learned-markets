/*
 * dc-lite.js: a tiny runtime that renders the Learned Markets design files
 * as plain web pages (no build step, no dependencies).
 *
 * Each page has:
 *   <x-dc> ... </x-dc>   the markup, with {{holes}}, <sc-for> loops and <sc-if> branches
 *   a script tag of type "text/x-dc" holding: class Component extends DCLogic { ... }
 *
 * The Component keeps `state`, calls `setState`, and returns the values the
 * markup needs from `renderVals()`. On every state change the page is
 * re-rendered and patched in place, so CSS transitions and animations run.
 *
 * Props (like "lowTimer" or "empty") can be set from the URL: page.html?lowTimer=1
 */
(function () {
  'use strict';

  class DCLogic {
    constructor(props) { this.props = props || {}; this.state = {}; }
    setState(patch) {
      const next = typeof patch === 'function' ? patch(this.state, this.props) : patch;
      this.state = Object.assign({}, this.state, next);
      schedule();
    }
    forceUpdate() { schedule(); }
  }
  window.DCLogic = DCLogic;

  let instance = null, template = null, mount = null, pending = false;

  function schedule() {
    if (pending) return;
    pending = true;
    Promise.resolve().then(() => { pending = false; render(); });
  }

  // {{ a.b.c }} lookups. Literals true/false/null/numbers are allowed.
  function lookup(scope, expr) {
    const path = expr.trim();
    if (path === 'true') return true;
    if (path === 'false') return false;
    if (path === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(path)) return Number(path);
    return path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), scope);
  }
  const WHOLE = /^\{\{([^}]+)\}\}$/;
  const HOLE = /\{\{([^}]+)\}\}/g;
  function interp(str, scope) {
    return str.replace(HOLE, (_, e) => { const v = lookup(scope, e); return v == null ? '' : String(v); });
  }

  // React-style event props -> DOM events
  const EVENTS = {
    onclick: 'click', onchange: 'input', oninput: 'input', onpointermove: 'pointermove',
    onpointerdown: 'pointerdown', onpointerup: 'pointerup', onpointerleave: 'pointerleave',
    onmouseenter: 'mouseenter', onmouseleave: 'mouseleave', onkeydown: 'keydown', onsubmit: 'submit'
  };

  // Build a fresh DOM tree for the template with the current values.
  function build(node, scope, out) {
    if (node.nodeType === 3) { out.push(document.createTextNode(interp(node.nodeValue, scope))); return; }
    if (node.nodeType !== 1) return;
    const tag = node.localName;
    if (tag === 'helmet') return;
    if (tag === 'sc-for') {
      const m = WHOLE.exec(node.getAttribute('list') || '');
      const list = m ? lookup(scope, m[1]) : [];
      const as = node.getAttribute('as') || 'item';
      (Array.isArray(list) ? list : []).forEach((item, i) => {
        const s = Object.create(scope); s[as] = item; s.$index = i;
        node.childNodes.forEach((c) => build(c, s, out));
      });
      return;
    }
    if (tag === 'sc-if') {
      const m = WHOLE.exec(node.getAttribute('value') || '');
      if (m && lookup(scope, m[1])) node.childNodes.forEach((c) => build(c, scope, out));
      return;
    }
    const el = node.cloneNode(false); // keeps the SVG namespace
    el.__on = {};
    for (const a of Array.from(node.attributes)) {
      if (a.name.indexOf('hint-') === 0) { el.removeAttribute(a.name); continue; }
      const ev = EVENTS[a.name.toLowerCase()];
      const whole = WHOLE.exec(a.value);
      if (ev) {
        el.removeAttribute(a.name);
        if (whole) el.__on[ev] = lookup(scope, whole[1]);
        continue;
      }
      if (whole) {
        const v = lookup(scope, whole[1]);
        if (v === false || v == null) el.removeAttribute(a.name);
        else el.setAttribute(a.name, v === true ? '' : String(v));
      } else if (a.value.indexOf('{{') > -1) {
        el.setAttribute(a.name, interp(a.value, scope));
      }
    }
    const kids = [];
    node.childNodes.forEach((c) => build(c, scope, kids));
    kids.forEach((k) => el.appendChild(k));
    out.push(el);
  }

  // Patch the live DOM to match the new tree, keeping elements in place.
  function patch(parent, nextKids) {
    const cur = Array.from(parent.childNodes);
    nextKids.forEach((n, i) => {
      const c = cur[i];
      if (!c) { parent.appendChild(adopt(n)); return; }
      if (c.nodeType !== n.nodeType || (n.nodeType === 1 && c.localName !== n.localName)) {
        parent.replaceChild(adopt(n), c); return;
      }
      if (n.nodeType === 3) { if (c.nodeValue !== n.nodeValue) c.nodeValue = n.nodeValue; return; }
      syncAttrs(c, n);
      wire(c, n.__on);
      patch(c, Array.from(n.childNodes));
    });
    for (let i = cur.length - 1; i >= nextKids.length; i--) parent.removeChild(cur[i]);
  }
  function syncAttrs(c, n) {
    for (const a of Array.from(c.attributes)) if (!n.hasAttribute(a.name)) c.removeAttribute(a.name);
    for (const a of Array.from(n.attributes)) if (c.getAttribute(a.name) !== a.value) c.setAttribute(a.name, a.value);
    if (c.localName === 'input' && document.activeElement !== c && n.hasAttribute('value')) c.value = n.getAttribute('value');
  }
  function wire(el, handlers) {
    el.__on = handlers || {};
    el.__wired = el.__wired || {};
    Object.keys(el.__on).forEach((ev) => {
      if (el.__wired[ev]) return;
      el.__wired[ev] = true;
      el.addEventListener(ev, (e) => { const h = el.__on[ev]; if (typeof h === 'function') h(e); });
    });
  }
  function adopt(n) {
    if (n.nodeType === 1) {
      wire(n, n.__on);
      n.querySelectorAll('*').forEach((d) => wire(d, d.__on));
    }
    return n;
  }

  function render() {
    const vals = instance.renderVals();
    const out = [];
    template.childNodes.forEach((c) => build(c, vals, out));
    patch(mount, out);
  }

  function boot() {
    const xdc = document.querySelector('x-dc');
    const script = document.querySelector('script[data-dc-script]');
    if (!xdc || !script) return;

    // Move <helmet> styles into <head>.
    xdc.querySelectorAll('helmet').forEach((h) => {
      Array.from(h.children).forEach((c) => document.head.appendChild(c));
    });

    template = xdc.cloneNode(true);
    mount = document.createElement('div');
    mount.className = 'dc-root';
    xdc.replaceWith(mount);

    // Props: defaults from data-props, overridden by the URL query.
    const props = {};
    try {
      const spec = JSON.parse(script.getAttribute('data-props') || '{}');
      Object.keys(spec).forEach((k) => { if (k[0] !== '$' && 'default' in spec[k]) props[k] = spec[k].default; });
    } catch (e) { /* ignore bad props */ }
    new URLSearchParams(location.search).forEach((v, k) => {
      props[k] = v === '1' || v === 'true' ? true : v === '0' || v === 'false' ? false : v;
    });

    const Component = new Function('DCLogic', script.textContent + '\n;return Component;')(DCLogic);
    instance = new Component(props);
    instance.props = props;
    instance.state = instance.state || {};
    render();
    if (typeof instance.componentDidMount === 'function') instance.componentDidMount();
    window.addEventListener('pagehide', () => {
      if (typeof instance.componentWillUnmount === 'function') instance.componentWillUnmount();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
