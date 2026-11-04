from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .config import BrowserError

# State is an opaque JSHandle retained in Python, not a property on window/DOM.
# References identify observed DOM nodes, never model-provided selectors or scripts.
NEW_STATE_SCRIPT = "() => ({ids:new WeakMap(),next:1})"
SNAPSHOT_SCRIPT = r"""state => {
  const nodes = [], elements = [];
  const candidates = document.querySelectorAll('a[href],button,input,textarea,select,summary,[role],[contenteditable="true"],h1,h2,h3,h4,label');
  for (const el of candidates) {
    if (nodes.length >= 200) break;
    const box = el.getBoundingClientRect(), style = getComputedStyle(el);
    if (!box.width || !box.height || style.visibility === 'hidden' || style.display === 'none' || box.bottom < 0 || box.top > innerHeight || box.right < 0 || box.left > innerWidth) continue;
    let key = state.ids.get(el);
    if (!key) { key = 'e' + state.next++; state.ids.set(el,key); }
    const tag = el.tagName.toLowerCase();
    const inputRole = ({checkbox:'checkbox',radio:'radio',button:'button',submit:'button',reset:'button'}[el.type] || 'textbox');
    const role = el.getAttribute('role') || ({a:'link',button:'button',input:inputRole,textarea:'textbox',select:'combobox',summary:'button'}[tag] || tag);
    const labels = el.labels ? Array.from(el.labels).map(l => l.innerText).join(' ') : '';
    const labelledBy = (el.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.innerText || '').join(' ');
    const buttonValue = tag==='input' && ['button','submit','reset'].includes(el.type) ? el.value : '';
    const name = (el.getAttribute('aria-label') || labelledBy.trim() || labels || el.innerText || buttonValue || el.getAttribute('placeholder') || el.getAttribute('title') || '').replace(/\s+/g,' ').trim().slice(0,180);
    elements.push({key,role,name,tag,type:el.getAttribute('type') || undefined,disabled:!!el.disabled,checked:['checkbox','radio'].includes(role)?!!el.checked:undefined,href:tag==='a'?el.href:undefined});
    nodes.push(el);
  }
  return {title:document.title.slice(0,300),url:location.href,text:(document.body?.innerText || '').slice(0,16000),elements,nodes};
}"""


@dataclass
class ReferenceStore:
    tab: str
    document: int = 1
    handles: dict[str, Any] = field(default_factory=dict)

    def reset(self) -> None:
        self.document += 1
        self.handles.clear()

    def replace(self, handles: dict[str, Any]) -> None:
        self.handles = {self.reference(key): handle for key, handle in handles.items()}

    def reference(self, key: str) -> str:
        return f"{self.tab}-d{self.document}-{key}"

    def resolve(self, ref: str) -> Any:
        if ref not in self.handles:
            raise BrowserError("reference_stale: take a new snapshot and use a reference shown for this tab")
        return self.handles[ref]
