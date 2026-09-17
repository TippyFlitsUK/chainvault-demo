// theme: system preference by default; the header button cycles system -> light -> dark and remembers it.
(function () {
  const url = new URL(location.href); const forced = url.searchParams.get('theme');
  let mode = forced || (function () { try { return localStorage.getItem('cv_theme') || 'system'; } catch { return 'system'; } })();
  const apply = () => { if (mode === 'light' || mode === 'dark') document.documentElement.setAttribute('data-theme', mode); else document.documentElement.removeAttribute('data-theme'); };
  apply();
  window.addEventListener('DOMContentLoaded', () => {
    const host = document.querySelector('header .headright') || document.querySelector('header');
    const b = document.createElement('button'); b.className = 'themebtn'; b.type = 'button';
    const label = () => { b.textContent = mode === 'system' ? 'theme: system' : mode === 'light' ? 'theme: light' : 'theme: dark'; };
    label();
    b.onclick = () => { mode = mode === 'system' ? 'light' : mode === 'light' ? 'dark' : 'system'; try { localStorage.setItem('cv_theme', mode); } catch {} apply(); label(); };
    host.appendChild(b);
  });
})();
