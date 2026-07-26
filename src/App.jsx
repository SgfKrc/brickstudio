import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { BrickEditor } from './editor/BrickEditor.js';
import { PartLibrary } from './editor/PartLibrary.js';
import { CATEGORIES, PARTS, searchParts, partById } from './parts-catalog.js';
import { LDRAW_COLORS, colorByCode, DEFAULT_COLOR } from './colors.js';
import { serializeLDR, parseLDR, downloadText, newBrickId, stepGroups } from './ldraw-io.js';
import { api } from './api.js';
import { makeXlsx, makeCsv } from './xlsx-export.js';
import { saveBinaryFile } from './save-file.js';

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
  const [rotPivot, setRotPivot] = useState('centroid'); // centroid | primary(铰链)
  const [recent, setRecent] = useState(() => {
    try { return JSON.parse(localStorage.getItem('bs-recent') || '[]'); } catch { return []; }
  });
  const [connectCheck, setConnectCheck] = useState(true);
  const [toast, setToast] = useState(null);
  const [serverMode, setServerMode] = useState(false);
  const [perfMode, setPerfMode] = useState(() => {
    try { return localStorage.getItem('bs-perf') === '1'; } catch { return false; }
  });
  // 零件面板布局:auto(宽屏左侧/窄屏底部)| left | bottom
  const [layoutPref, setLayoutPref] = useState(() => {
    try { return localStorage.getItem('bs-layout') || 'auto'; } catch { return 'auto'; }
  });
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 900);
  const [recentColors, setRecentColors] = useState(() => {
    try { return JSON.parse(localStorage.getItem('bs-recent-colors') || '[]'); } catch { return []; }
  });
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 900);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const layout = layoutPref === 'auto' ? (wide ? 'left' : 'bottom') : layoutPref;
  const [steps, setSteps] = useState(null); // {list, idx} 步骤预览状态
  const [showLibrary, setShowLibrary] = useState(false);
  const [showSaveAs, setShowSaveAs] = useState(false);
  const [models, setModels] = useState([]);
  const [saveName, setSaveName] = useState('我的模型');
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
      onModeSwitch: (m) => setMode(m),
      onChange: ({ count }) => {
        setCount(count);
        // 自动保存(防抖;有后端走后端,否则 localStorage)
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          api.saveAuto(serializeLDR(ed.getBricks()));
        }, 800);
      },
      onError: say,
    });
    editorRef.current = ed;
    if (typeof window !== 'undefined') window.__bs = { editor: ed, lib, serializeLDR, parseLDR, PARTS, searchParts, stepGroups };
    try { if (localStorage.getItem('bs-perf') === '1') ed.setPerfMode(true); } catch { /* 忽略 */ }
    lib.init().then(async () => {
      setReady(true);
      setServerMode(await api.detect());
      // 恢复上次自动保存
      try {
        const saved = await api.loadAuto();
        // 用户若已开始搭建,不要用自动保存覆盖
        if (saved && ed.getBricks().length === 0) {
          const { bricks } = parseLDR(saved);
          if (bricks.length && ed.getBricks().length === 0) {
            await ed.loadBricks(bricks.map(b => ({ ...b, id: newBrickId() })));
            say(`已恢复上次的模型(${bricks.length} 个零件)`);
          }
        }
      } catch { /* 忽略 */ }
    });
    return () => { ed.dispose(); editorRef.current = null; };
  }, [say]);

  // 桌面快捷键
  const serverModeRef = useRef(false);
  useEffect(() => { serverModeRef.current = serverMode; }, [serverMode]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT') return;
      const ed0 = editorRef.current;
      if (!ed0) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? ed0.redo() : ed0.undo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); ed0.redo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); ed0.duplicateSelected(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (serverModeRef.current) setShowSaveAs(true);
      }
      else if (e.key === 'Escape') {
        setShowColors(false); setShowMenu(false); setShowRotate(false);
        setShowBom(false); setShowLibrary(false); setShowSaveAs(false);
        ed0.clearSelection();
      }
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
    setRecentColors(prev => {
      const next = [code, ...prev.filter(c => c !== code)].slice(0, 10);
      try { localStorage.setItem('bs-recent-colors', JSON.stringify(next)); } catch { /* 忽略 */ }
      return next;
    });
  };

  const cycleLayout = () => {
    const next = layoutPref === 'auto' ? 'left' : layoutPref === 'left' ? 'bottom' : 'auto';
    setLayoutPref(next);
    try { localStorage.setItem('bs-layout', next); } catch { /* 忽略 */ }
    say(next === 'auto' ? '零件面板:自动(宽屏左侧)' : next === 'left' ? '零件面板:左侧' : '零件面板:底部');
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
    // 按层插入 0 STEP:Studio/LeoCAD 打开即有搭建步骤
    const text = serializeLDR(bricks, null, saveName || 'BrickStudio Model', { steps: true });
    const name = `${saveName || 'model'}-${new Date().toISOString().slice(0, 10)}.ldr`;
    downloadText(name, text);
    say(`已导出 ${name}(${bricks.length} 个零件,含分步)`);
    setShowMenu(false);
  };

  // ---- 步骤预览 ----
  const enterSteps = () => {
    const list = stepGroups(ed()?.getBricks() || []);
    if (!list.length) { say('模型是空的'); return; }
    setShowMenu(false);
    setSteps({ list, idx: list.length });
    applyStep(list, list.length);
  };
  const applyStep = (list, idx) => {
    const visible = new Set();
    for (let i = 0; i < idx; i++) for (const b of list[i]) visible.add(b.id);
    ed()?.setVisibleFilter(b => visible.has(b.id));
  };
  const changeStep = (idx) => {
    if (!steps) return;
    idx = Math.max(1, Math.min(steps.list.length, idx));
    setSteps({ ...steps, idx });
    applyStep(steps.list, idx);
  };
  const exitSteps = () => {
    setSteps(null);
    ed()?.setVisibleFilter(null);
  };

  const togglePerf = () => {
    const v = !perfMode;
    setPerfMode(v);
    ed()?.setPerfMode(v);
    try { localStorage.setItem('bs-perf', v ? '1' : '0'); } catch { /* 忽略 */ }
    say(v ? '高性能模式已开启(关闭阴影与边线)' : '已恢复完整画质');
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

  // ---- 模型库(后端) ----
  const openLibrary = async () => {
    setShowMenu(false);
    try { setModels(await api.list()); } catch { setModels([]); }
    setShowLibrary(true);
  };

  const saveToLibrary = async () => {
    const name = saveName.trim();
    if (!name) return;
    const bricks = ed()?.getBricks() || [];
    if (!bricks.length) { say('模型是空的'); return; }
    try {
      await api.save(name, serializeLDR(bricks, null, name));
      say(`已保存「${name}」(${bricks.length} 个零件)`);
      setShowSaveAs(false);
    } catch (e) { say(String(e.message || e)); }
  };

  const openFromLibrary = async (name) => {
    try {
      const text = await api.load(name);
      const { bricks } = parseLDR(text);
      if (!bricks.length) { say('模型为空'); return; }
      const failed = await ed()?.loadBricks(bricks.map(b => ({ ...b, id: newBrickId() })));
      say(`已打开「${name}」${failed?.length ? `,${failed.length} 种零件缺失` : ''}`);
      setSaveName(name);
      setShowLibrary(false);
    } catch (e) { say(String(e.message || e)); }
  };

  const deleteFromLibrary = async (name) => {
    await api.remove(name);
    setModels(await api.list());
    say(`已删除「${name}」`);
  };

  const applyRotate = (deg) => {
    if (!deg) return;
    if (mode === 'select' && selection) ed()?.rotateSelectedBy(rotAxisSel, deg, rotLocal, rotPivot);
    else {
      ed()?.rotatePendingBy(rotAxisSel, deg, rotLocal);
      say(`待放置零件已绕${rotLocal ? '自身' : '世界'} ${rotAxisSel.toUpperCase()} 轴旋转 ${deg}°`);
    }
  };

  const selectLinked = () => {
    const n = ed()?.selectConnectedAbove() ?? 0;
    say(n > 0 ? `已连带选中上方 ${n} 个零件` : '上方没有相连的零件');
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
        const p = partById(b.partId);
        map.set(key, { partId: b.partId, name: p?.name || b.partId, en: p?.en || '', color: b.colorCode, n: 0 });
      }
      map.get(key).n++;
    }
    return [...map.values()].sort((a, b) => b.n - a.n);
  }, [showBom, count]);

  const bomTable = () => {
    const head = ['零件号', '名称', 'Part Name', 'LDraw颜色码', '颜色', 'Color', '颜色HEX', '数量'];
    const rows = bomRows.map(r => {
      const c = colorByCode(r.color);
      return [r.partId, r.name, r.en, r.color, c.name, c.en || '', c.hex || '', r.n];
    });
    rows.push(['', '', '', '', '', '', '合计', bomRows.reduce((s, r) => s + r.n, 0)]);
    return [head, ...rows];
  };

  const downloadBlob = (data, filename, mime) => {
    saveBinaryFile(data, filename, mime);
  };

  const exportBomCsv = () => {
    downloadBlob(makeCsv(bomTable()), `零件表-${saveName || 'model'}-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv;charset=utf-8');
    say('已导出 CSV 零件表');
  };

  const exportBomXlsx = () => {
    downloadBlob(makeXlsx(bomTable(), '零件表'), `零件表-${saveName || 'model'}-${new Date().toISOString().slice(0, 10)}.xlsx`,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    say('已导出 XLSX 零件表');
  };

  const shownParts = useMemo(() => {
    if (query.trim()) return searchParts(query);
    if (cat === 'recent') return recent.map(id => PARTS.find(p => p.id === id)).filter(Boolean);
    return PARTS.filter(p => p.cat === cat);
  }, [query, cat, recent]);

  const activeColorInfo = colorByCode(color);
  const selName = selection?.partId ? (partById(selection.partId)?.name || selection.partId) : null;

  const palette = (
    <div key="palette" className={`palette ${layout === 'left' ? 'palette-left' : ''}`}>
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
  );

  return (
    <div className={`app ${layout === 'left' ? 'layout-left' : ''}`}>
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

      <div className="main">
        {layout === 'left' && palette}
        <div key="viewport" className="viewport" ref={viewRef}>
          {!ready && <div className="loading">正在加载零件库…</div>}
        </div>
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
          <button onClick={selectLinked} title="连带选中扣在上面的所有零件">⛓</button>
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

      {layout === 'bottom' && palette}

      {showColors && (
        <div className="sheet-backdrop" onClick={() => setShowColors(false)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <div className="sheet-title">选择颜色</div>
            {recentColors.length > 0 && (
              <div className="recent-colors">
                <span className="rc-label">最近:</span>
                {recentColors.map(code => {
                  const c = colorByCode(code);
                  return (
                    <button key={code} className={`sw sw-sm ${color === code ? 'on' : ''}`}
                      style={{ background: c.hex, opacity: c.alpha ?? 1 }}
                      onClick={() => pickColor(code)} title={c.name} />
                  );
                })}
              </div>
            )}
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
            {mode === 'select' && selection && (
              <div className="rot-axes">
                <button className={`axis-btn ${rotPivot === 'centroid' ? 'on' : ''}`} onClick={() => setRotPivot('centroid')}>支点:组中心</button>
                <button className={`axis-btn ${rotPivot === 'primary' ? 'on' : ''}`} onClick={() => setRotPivot('primary')}>支点:基准件(铰链)</button>
              </div>
            )}
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
            <div className="sheet-title">
              零件清单(共 {count} 件)
              <span className="bom-actions">
                <button className="lib-btn" onClick={exportBomCsv}>⬇CSV</button>
                <button className="lib-btn" onClick={exportBomXlsx}>⬇XLSX</button>
              </span>
            </div>
            <div className="bom">
              {bomRows.map((r, i) => (
                <div className="bom-row clickable" key={i} title="点击选用该零件与颜色"
                  onClick={() => { if (!r.partId) return; pickPart(r.partId); pickColor(r.color); setShowBom(false); }}>
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

      {showSaveAs && (
        <div className="sheet-backdrop" onClick={() => setShowSaveAs(false)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <div className="sheet-title">保存到模型库</div>
            <div className="rot-custom">
              <input value={saveName} onChange={e => setSaveName(e.target.value)}
                placeholder="模型名称" maxLength={40} />
              <button onClick={saveToLibrary}>💾 保存</button>
            </div>
            <div className="menu-tip">保存为标准 .ldr 文件,存放在 models/ 目录,可直接用其他软件打开</div>
          </div>
        </div>
      )}

      {showLibrary && (
        <div className="sheet-backdrop" onClick={() => setShowLibrary(false)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <div className="sheet-title">模型库({models.length})</div>
            <div className="bom">
              {models.map(m => (
                <div className="bom-row" key={m.name}>
                  <span className="bom-name">{m.name}</span>
                  <span className="bom-color">{new Date(m.mtime).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                  <button className="lib-btn" onClick={() => openFromLibrary(m.name)}>打开</button>
                  <button className="lib-btn danger" onClick={() => deleteFromLibrary(m.name)}>删除</button>
                </div>
              ))}
              {!models.length && <div className="no-result">模型库是空的,先「保存到模型库」吧</div>}
            </div>
          </div>
        </div>
      )}

      {showMenu && (
        <div className="sheet-backdrop" onClick={() => setShowMenu(false)}>
          <div className="menu" onClick={e => e.stopPropagation()}>
            <button onClick={onNew}>🗋 新建</button>
            {serverMode && <button onClick={() => { setShowMenu(false); setShowSaveAs(true); }}>💾 保存到模型库</button>}
            {serverMode && <button onClick={openLibrary}>📁 模型库</button>}
            <button onClick={() => fileRef.current?.click()}>📂 打开 .ldr / .mpd 文件</button>
            <button onClick={onSave}>⬇ 导出 .ldr 文件</button>
            <button onClick={onExportImage}>🖼 导出图片</button>
            <button onClick={() => { setShowBom(true); setShowMenu(false); }}>📋 零件清单</button>
            <button onClick={() => {
              const v = !connectCheck;
              setConnectCheck(v);
              ed()?.setConnectCheck(v);
              say(v ? '已开启卡扣连接检测' : '已关闭连接检测(自由放置)');
            }}>{connectCheck ? '🧲 连接检测:开' : '🧲 连接检测:关'}</button>
            <button onClick={enterSteps}>👣 步骤预览</button>
            <button onClick={togglePerf}>{perfMode ? '⚡ 高性能模式:开' : '⚡ 高性能模式:关'}</button>
            <button onClick={cycleLayout}>
              ◧ 零件面板:{layoutPref === 'auto' ? `自动(当前${layout === 'left' ? '左侧' : '底部'})` : layoutPref === 'left' ? '左侧' : '底部'}
            </button>
            <div className="view-row">
              {[['iso', '等轴'], ['top', '顶'], ['front', '前'], ['side', '侧']].map(([k, n]) => (
                <button key={k} onClick={() => { ed()?.setView(k); setShowMenu(false); }}>{n}</button>
              ))}
            </div>
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

      {steps && (
        <div className="stepbar">
          <button className="lib-btn" onClick={() => changeStep(steps.idx - 1)}>◀</button>
          <input type="range" min={1} max={steps.list.length} value={steps.idx}
            onChange={e => changeStep(parseInt(e.target.value, 10))} />
          <span className="step-label">步骤 {steps.idx}/{steps.list.length}</span>
          <button className="lib-btn" onClick={() => changeStep(steps.idx + 1)}>▶</button>
          <button className="lib-btn danger" onClick={exitSteps}>✕</button>
        </div>
      )}

      <input ref={fileRef} type="file" accept=".ldr,.mpd,.dat,.txt" hidden onChange={onOpenFile} />
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
