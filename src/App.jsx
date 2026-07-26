import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { BrickEditor } from './editor/BrickEditor.js';
import { PartLibrary } from './editor/PartLibrary.js';
import { CATEGORIES, PARTS, searchParts, partById } from './parts-catalog.js';
import { LDRAW_COLORS, colorByCode, DEFAULT_COLOR } from './colors.js';
import { serializeLDR, parseLDR, downloadText, newBrickId } from './ldraw-io.js';

const MODES = [
  { id: 'place',  icon: '🧱', name: '放置' },
  { id: 'select', icon: '👆', name: '选择' },
  { id: 'paint',  icon: '🎨', name: '上色' },
  { id: 'erase',  icon: '🧹', name: '删除' },
];

// 懒加载缩略图按钮(进入视口才渲染)
function PartButton({ part, active, lib, ready, onPick }) {
  const ref = useRef(null);
  const [thumb, setThumb] = useState(null);
  useEffect(() => {
    if (!ready || thumb || !ref.current || !lib) return;
    const el = ref.current;
    const obs = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) {
        obs.disconnect();
        lib.thumbnail(part.id).then(setThumb).catch(() => {});
      }
    }, { root: el.closest('.parts'), rootMargin: '200px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [ready, thumb, lib, part.id]);
  return (
    <button ref={ref} className={`part-btn ${active ? 'on' : ''}`} onClick={() => onPick(part.id)} title={part.en}>
      {thumb
        ? <img src={thumb} alt={part.name} draggable={false} />
        : <span className="part-ph">{part.id}</span>}
      <span className="part-name">{part.name}</span>
    </button>
  );
}

export default function App() {
  const viewRef = useRef(null);
  const editorRef = useRef(null);
  const libRef = useRef(null);
  const fileRef = useRef(null);

  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState('place');
  const [cat, setCat] = useState('brick');
  const [query, setQuery] = useState('');
  const [activePart, setActivePart] = useState('3001');
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [selection, setSelection] = useState(null);
  const [multi, setMulti] = useState(false);
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });
  const [count, setCount] = useState(0);
  const [showColors, setShowColors] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showRotate, setShowRotate] = useState(false);
  const [showBom, setShowBom] = useState(false);
  const [rotAxisSel, setRotAxisSel] = useState('y');
  const [rotAngle, setRotAngle] = useState('45');
  const [rotLocal, setRotLocal] = useState(false);
  const [recent, setRecent] = useState(() => {
    try { return JSON.parse(localStorage.getItem('bs-recent') || '[]'); } catch { return []; }
  });
  const [connectCheck, setConnectCheck] = useState(true);
  const [toast, setToast] = useState(null);
  const saveTimer = useRef(null);

  const say = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => {
    if (!viewRef.current || editorRef.current) return;
    const lib = new PartLibrary('./');
    libRef.current = lib;
    const ed = new BrickEditor(viewRef.current, lib, {
      onSelect: setSelection,
      onHistory: setHistory,
      onChange: ({ count }) => {
        setCount(count);
        // 自动保存(防抖)
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          try { localStorage.setItem('bs-autosave', serializeLDR(ed.getBricks())); } catch { /* 空间不足等忽略 */ }
        }, 800);
      },
      onError: say,
    });
    editorRef.current = ed;
    if (typeof window !== 'undefined') window.__bs = { editor: ed, lib, serializeLDR, parseLDR, PARTS, searchParts };
    lib.init().then(async () => {
      setReady(true);
      // 恢复上次自动保存
      try {
        const saved = localStorage.getItem('bs-autosave');
        if (saved) {
          const { bricks } = parseLDR(saved);
          if (bricks.length) {
            await ed.loadBricks(bricks.map(b => ({ ...b, id: newBrickId() })));
            say(`已恢复上次的模型(${bricks.length} 个零件)`);
          }
        }
      } catch { /* 忽略 */ }
    });
    return () => { ed.dispose(); editorRef.current = null; };
  }, [say]);

  // 桌面快捷键
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT') return;
      const ed0 = editorRef.current;
      if (!ed0) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? ed0.redo() : ed0.undo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); ed0.redo(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') ed0.deleteSelected();
      else if (e.key.toLowerCase() === 'r') { ed0.selection.size ? ed0.rotateSelected() : ed0.rotatePending(); }
      else if (e.key.toLowerCase() === 'f') { ed0.selection.size ? ed0.flipSelected() : ed0.flipPending(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const ed = () => editorRef.current;

  const pickMode = (m) => { setMode(m); ed()?.setMode(m); if (m !== 'select') { setMulti(false); ed()?.setMultiMode(false); } };
  const pickPart = (id) => {
    setActivePart(id);
    ed()?.setActivePart(id);
    if (mode !== 'place') pickMode('place');
    setRecent(prev => {
      const next = [id, ...prev.filter(x => x !== id)].slice(0, 30);
      try { localStorage.setItem('bs-recent', JSON.stringify(next)); } catch { /* 忽略 */ }
      return next;
    });
  };
  const pickColor = (code) => {
    setColor(code);
    ed()?.setActiveColor(code);
    setShowColors(false);
  };
  const toggleMulti = () => {
    const v = !multi;
    setMulti(v);
    ed()?.setMultiMode(v);
  };

  const onRotate = () => {
    if (mode === 'select' && selection) ed()?.rotateSelected();
    else ed()?.rotatePending();
  };
  const onFlip = () => {
    if (mode === 'select' && selection) ed()?.flipSelected();
    else { ed()?.flipPending(); say('已翻转(再点可继续旋转姿态)'); }
  };

  const onSave = () => {
    const bricks = ed()?.getBricks() || [];
    if (!bricks.length) { say('模型是空的'); return; }
    const text = serializeLDR(bricks);
    const name = `model-${new Date().toISOString().slice(0, 10)}.ldr`;
    downloadText(name, text);
    say(`已导出 ${name}(${bricks.length} 个零件)`);
    setShowMenu(false);
  };

  const onOpenFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    const { bricks, warnings } = parseLDR(text);
    if (!bricks.length) { say('未能从文件中解析出零件'); return; }
    const failed = await ed()?.loadBricks(bricks.map(b => ({ ...b, id: newBrickId() })));
    let msg = `已加载 ${bricks.length} 个零件`;
    if (failed?.length) msg += `,${failed.length} 种零件不在零件库中被跳过`;
    say(msg);
    if (warnings.length) console.warn(warnings);
    setShowMenu(false);
  };

  const onNew = async () => {
    await ed()?.clearAll();
    setShowMenu(false);
  };

  const applyRotate = (deg) => {
    if (!deg) return;
    if (mode === 'select' && selection) ed()?.rotateSelectedBy(rotAxisSel, deg, rotLocal);
    else {
      ed()?.rotatePendingBy(rotAxisSel, deg, rotLocal);
      say(`待放置零件已绕${rotLocal ? '自身' : '世界'} ${rotAxisSel.toUpperCase()} 轴旋转 ${deg}°`);
    }
  };

  const onExportImage = () => {
    const url = ed()?.exportImage();
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = `brickstudio-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    say('已导出当前视图图片');
    setShowMenu(false);
  };

  const bomRows = useMemo(() => {
    if (!showBom) return [];
    const map = new Map();
    for (const b of ed()?.getBricks() || []) {
      const key = `${b.partId}/${b.colorCode}`;
      if (!map.has(key)) {
        map.set(key, { name: partById(b.partId)?.name || b.partId, color: b.colorCode, n: 0 });
      }
      map.get(key).n++;
    }
    return [...map.values()].sort((a, b) => b.n - a.n);
  }, [showBom, count]);

  const shownParts = useMemo(() => {
    if (query.trim()) return searchParts(query);
    if (cat === 'recent') return recent.map(id => PARTS.find(p => p.id === id)).filter(Boolean);
    return PARTS.filter(p => p.cat === cat);
  }, [query, cat, recent]);

  const activeColorInfo = colorByCode(color);
  const selName = selection?.partId ? (partById(selection.partId)?.name || selection.partId) : null;

  return (
    <div className="app">
      <header className="topbar">
        <button className="tb-btn" onClick={() => setShowMenu(v => !v)}>☰</button>
        <div className="title">BrickStudio<span className="count">{count > 0 ? ` · ${count}` : ''}</span></div>
        <button className="tb-btn" disabled={!history.canUndo} onClick={() => ed()?.undo()}>↩</button>
        <button className="tb-btn" disabled={!history.canRedo} onClick={() => ed()?.redo()}>↪</button>
        <button className="tb-btn" onClick={onRotate} title="水平旋转90°">⟳</button>
        <button className="tb-btn" onClick={onFlip} title="翻转(竖直旋转90°)">⤸</button>
        <button className="tb-btn" onClick={() => setShowRotate(true)} title="按角度旋转">📐</button>
        <button className="tb-btn swatch" onClick={() => setShowColors(v => !v)}
          style={{ background: activeColorInfo.hex }} title={activeColorInfo.name} />
      </header>

      <div className="viewport" ref={viewRef}>
        {!ready && <div className="loading">正在加载零件库…</div>}
      </div>

      <div className="modes">
        {MODES.map(m => (
          <button key={m.id} className={`mode-btn ${mode === m.id ? 'on' : ''}`}
            onClick={() => pickMode(m.id)}>
            <span className="mi">{m.icon}</span><span>{m.name}</span>
          </button>
        ))}
        {mode === 'select' && (
          <button className={`mode-btn ${multi ? 'on' : ''}`} onClick={toggleMulti}>
            <span className="mi">☑️</span><span>多选</span>
          </button>
        )}
      </div>

      {selection && mode === 'select' && (
        <div className="selbar">
          <span className="sel-info">
            {selection.count > 1 ? `${selection.count} 个零件${selection.grouped ? '(组)' : ''}` : selName}
          </span>
          <button onClick={() => ed()?.rotateSelected()}>⟳</button>
          <button onClick={() => ed()?.flipSelected()}>⤸</button>
          <button onClick={() => ed()?.duplicateSelected()}>⧉</button>
          <button onClick={() => setShowColors(true)}>🎨</button>
          {selection.count > 1 && !selection.grouped &&
            <button onClick={() => ed()?.groupSelected()}>🔗组</button>}
          {selection.grouped &&
            <button onClick={() => ed()?.ungroupSelected()}>✂️拆组</button>}
          <button className="danger" onClick={() => ed()?.deleteSelected()}>🗑</button>
        </div>
      )}

      <div className="palette">
        <div className="pal-head">
          <input
            className="search"
            placeholder="🔍 搜索零件:如 2x4、斜面、window…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          {query && <button className="clear-q" onClick={() => setQuery('')}>✕</button>}
        </div>
        {!query && (
          <div className="cats">
            {CATEGORIES.map(c => (
              <button key={c.id} className={`cat-btn ${cat === c.id ? 'on' : ''}`} onClick={() => setCat(c.id)}>
                {c.name}
              </button>
            ))}
          </div>
        )}
        <div className="parts">
          {shownParts.length === 0 && <div className="no-result">没有匹配的零件</div>}
          {shownParts.map(p => (
            <PartButton key={p.id} part={p} active={activePart === p.id}
              lib={libRef.current} ready={ready} onPick={pickPart} />
          ))}
        </div>
      </div>

      {showColors && (
        <div className="sheet-backdrop" onClick={() => setShowColors(false)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <div className="sheet-title">选择颜色</div>
            <div className="swatches">
              {LDRAW_COLORS.map(c => (
                <button key={c.code} className={`sw ${color === c.code ? 'on' : ''}`}
                  style={{ background: c.hex, opacity: c.alpha ?? 1 }}
                  onClick={() => pickColor(c.code)}
                  title={`${c.name} (${c.code})`} />
              ))}
            </div>
          </div>
        </div>
      )}

      {showRotate && (
        <div className="sheet-backdrop" onClick={() => setShowRotate(false)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <div className="sheet-title">
              按角度旋转 — 作用于{selection && mode === 'select' ? `选中的 ${selection.count} 个零件` : '待放置零件'}
            </div>
            <div className="rot-axes">
              {['x', 'y', 'z'].map(a => (
                <button key={a} className={`axis-btn ${rotAxisSel === a ? 'on' : ''}`}
                  onClick={() => setRotAxisSel(a)}>
                  {a.toUpperCase()} 轴{a === 'y' ? '(水平)' : ''}
                </button>
              ))}
            </div>
            <div className="rot-axes">
              <button className={`axis-btn ${!rotLocal ? 'on' : ''}`} onClick={() => setRotLocal(false)}>🌐 世界轴</button>
              <button className={`axis-btn ${rotLocal ? 'on' : ''}`} onClick={() => setRotLocal(true)}>📦 自身轴</button>
            </div>
            <div className="rot-quick">
              {[-90, -45, -30, -15, 15, 30, 45, 90].map(d => (
                <button key={d} onClick={() => applyRotate(d)}>{d > 0 ? `+${d}` : d}°</button>
              ))}
            </div>
            <div className="rot-custom">
              <input type="number" inputMode="decimal" value={rotAngle}
                onChange={e => setRotAngle(e.target.value)} placeholder="角度" />
              <button onClick={() => applyRotate(-parseFloat(rotAngle) || 0)}>↺ 逆时针</button>
              <button onClick={() => applyRotate(parseFloat(rotAngle) || 0)}>↻ 顺时针</button>
            </div>
            <div className="menu-tip">非 90° 姿态将按"自由放置"处理(不做卡扣/碰撞判定)</div>
          </div>
        </div>
      )}

      {showBom && (
        <div className="sheet-backdrop" onClick={() => setShowBom(false)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <div className="sheet-title">零件清单(共 {count} 件)</div>
            <div className="bom">
              {bomRows.map((r, i) => (
                <div className="bom-row" key={i}>
                  <span className="bom-sw" style={{ background: colorByCode(r.color).hex }} />
                  <span className="bom-name">{r.name}</span>
                  <span className="bom-color">{colorByCode(r.color).name}</span>
                  <span className="bom-n">×{r.n}</span>
                </div>
              ))}
              {!bomRows.length && <div className="no-result">还没有零件</div>}
            </div>
          </div>
        </div>
      )}

      {showMenu && (
        <div className="sheet-backdrop" onClick={() => setShowMenu(false)}>
          <div className="menu" onClick={e => e.stopPropagation()}>
            <button onClick={onNew}>🗋 新建</button>
            <button onClick={() => fileRef.current?.click()}>📂 打开 .ldr / .mpd</button>
            <button onClick={onSave}>💾 导出 .ldr</button>
            <button onClick={onExportImage}>🖼 导出图片</button>
            <button onClick={() => { setShowBom(true); setShowMenu(false); }}>📋 零件清单</button>
            <button onClick={() => {
              const v = !connectCheck;
              setConnectCheck(v);
              ed()?.setConnectCheck(v);
              say(v ? '已开启卡扣连接检测' : '已关闭连接检测(自由放置)');
            }}>{connectCheck ? '🧲 连接检测:开' : '🧲 连接检测:关'}</button>
            <button onClick={() => { ed()?.fitCamera(); setShowMenu(false); }}>🎯 视角复位</button>
            <div className="menu-tip">
              单指旋转视角 · 双指缩放/平移<br />
              「放置」点击地面/零件顶部放砖;点击侧向柱钉可侧向拼接<br />
              ⟳ 水平旋转 · ⤸ 竖直翻转(组合出全部 24 种姿态)<br />
              「选择」+「多选」可框选整组移动/分组<br />
              导出的 .ldr 可在 BrickLink Studio / LeoCAD 中打开
            </div>
          </div>
        </div>
      )}

      <input ref={fileRef} type="file" accept=".ldr,.mpd,.dat,.txt" hidden onChange={onOpenFile} />
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
