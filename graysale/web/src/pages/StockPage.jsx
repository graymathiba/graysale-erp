import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../api/AuthContext';
import { useToast } from '../components/Toast';
import { api } from '../api/client';
import Modal from '../components/Modal';
import DataTable from '../components/DataTable';
import { fmtMoney, initials } from '../lib/format';
import CategorySelector from '../components/CategorySelect';

const TIER_NAMES = ['Wholesale', 'Member', 'Reseller'];
const UOM_NAMES = ['each', 'box', 'case', 'kg', 'g', 'L', 'ml'];
const BC_FORMATS = ['CODE128', 'EAN13', 'UPC-A', 'CODE39', 'ITF'];

const emptyForm = () => ({
  name: '',
  sku: '',
  barcode: '',
  description: '',
  brand: '',
  manufacturerPartNo: '',
  hsCode: '',
  categoryId: '',
  unit: 'each',
  binLocation: '',
  costCents: '',
  priceCents: '',
  taxClassId: 2,
  reorderLevel: 0,
  minStock: 0,
  maxStock: 0,
  leadTimeDays: 0,
  warrantyDays: 0,
  weightGrams: '',
  lengthMm: '',
  widthMm: '',
  heightMm: '',
  serialTracked: false,
  active: true,
  tiers: [],
  barcodes: [],
  uom: [],
  bundleComponents: [],
});

export default function StockPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [search, setSearch] = useState('');
  const [catId, setCatId] = useState('');
  const [cats, setCats] = useState([]);
  const [taxClasses, setTaxClasses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // null | {} (new) | product
  const [tab, setTab] = useState('general');
  const [form, setForm] = useState(emptyForm());
  const [adjusting, setAdjusting] = useState(null);
  const [adjustForm, setAdjustForm] = useState({ productId: null, qty: 0, type: 'ADJUST', note: '', batchNo: '' });
  const [newBarcode, setNewBarcode] = useState({ barcode: '', format: 'CODE128' });
  const [saving, setSaving] = useState(false);
  const [batchForm, setBatchForm] = useState(null); // batch add modal
  const [newBatch, setNewBatch] = useState({
    batchNo: '',
    manufactureDate: '',
    expiryDate: '',
    qtyOnHand: 0,
    location: '',
  });

  const load = useCallback(
    async (q, cid) => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (q) params.set('search', q);
        if (cid) params.set('categoryId', cid);
        const list = await api.get(`/products${params.toString() ? '?' + params.toString() : ''}`);
        setRows(Array.isArray(list) ? list : list.products || []);
      } catch (e) {
        if (e?.silent) return;
        toast.err(e.message);
      } finally {
        setLoading(false);
      }
    },
    [toast],
  );

  const loadMeta = useCallback(async () => {
    try {
      const [c, t] = await Promise.all([api.get('/categories'), api.get('/tax-classes')]);
      setCats(Array.isArray(c) ? c : c.categories || []);
      setTaxClasses(Array.isArray(t) ? t : t.tax_classes || []);
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    loadMeta();
    load('', '');
  }, [loadMeta, load]);
  useEffect(() => {
    const t = setTimeout(() => load(search, catId), 200);
    return () => clearTimeout(t);
  }, [search, catId, load]);

  // Create a new category, refresh the category list immediately so custom
  // categories populate the filter, and return the created category.
  const createCategory = async (name) => {
    const n = (name || '').trim();
    if (!n) return null;
    try {
      const res = await api.post('/categories', { name: n });
      const list = await api.get('/categories');
      const arr = Array.isArray(list) ? list : list.categories || [];
      setCats(arr);
      const created =
        arr.find((c) => c.id === Number(res?.id)) || arr.find((c) => c.name.toLowerCase() === n.toLowerCase());
      return created || { id: Number(res?.id), name: n };
    } catch (e) {
      toast.err(e.message);
      return null;
    }
  };

  const openNew = () => {
    if (!catId && cats.length) setForm({ ...emptyForm(), categoryId: cats[0].id });
    setEditing({});
    setTab('general');
  };
  const openEdit = (r) => {
    const f = emptyForm();
    for (const [key, col] of Object.entries({
      sku: 'sku',
      barcode: 'barcode',
      name: 'name',
      description: 'description',
      brand: 'brand',
      manufacturerPartNo: 'manufacturer_part_no',
      hsCode: 'hs_code',
      categoryId: 'category_id',
      unit: 'unit',
      binLocation: 'bin_location',
      costCents: 'cost_cents',
      priceCents: 'price_cents',
      taxClassId: 'tax_class_id',
      reorderLevel: 'reorder_level',
      minStock: 'min_stock',
      maxStock: 'max_stock',
      leadTimeDays: 'lead_time_days',
      warrantyDays: 'warranty_days',
      weightGrams: 'weight_grams',
      lengthMm: 'length_mm',
      widthMm: 'width_mm',
      heightMm: 'height_mm',
    })) {
      f[key] = r[col] ?? '';
    }
    f.serialTracked = !!r.serial_tracked;
    f.active = !!r.active;
    f.tiers = (r.tiers || []).map((t) => ({ tierName: t.tier_name, priceCents: t.price_cents, minQty: t.min_qty }));
    f.barcodes = (r.barcodes || [])
      .filter((b) => b.active)
      .map((b) => ({ barcode: b.barcode, format: b.format, isPrimary: !!b.is_primary }));
    f.uom = (r.uom || []).map((u) => ({
      uomName: u.uom_name,
      conversionFactor: u.conversion_factor,
      isBase: !!u.is_base,
      priceOverrideCents: u.price_override_cents,
    }));
    f.bundleComponents = (r.bundle_components || []).map((c) => ({
      componentProductId: c.component_product_id,
      qtyRequired: c.qty_required,
      name: c.name,
      sku: c.sku,
    }));
    setForm(f);
    setEditing(r);
    setTab('general');
  };

  const addTier = () => setForm({ ...form, tiers: [...form.tiers, { tierName: '', priceCents: '', minQty: 1 }] });
  const addUom = () =>
    setForm({
      ...form,
      uom: [...form.uom, { uomName: '', conversionFactor: 1, isBase: false, priceOverrideCents: '' }],
    });
  const addBundleComp = () =>
    setForm({ ...form, bundleComponents: [...form.bundleComponents, { componentProductId: '', qtyRequired: 1 }] });

  const setTier = (i, k, v) => setForm({ ...form, tiers: form.tiers.map((t, x) => (x === i ? { ...t, [k]: v } : t)) });
  const setUomF = (i, k, v) => setForm({ ...form, uom: form.uom.map((u, x) => (x === i ? { ...u, [k]: v } : u)) });
  const setBc = (i, k, v) =>
    setForm({ ...form, barcodes: form.barcodes.map((b, x) => (x === i ? { ...b, [k]: v } : b)) });
  const setComp = (i, k, v) =>
    setForm({ ...form, bundleComponents: form.bundleComponents.map((c, x) => (x === i ? { ...c, [k]: v } : c)) });

  const save = async () => {
    if (!form.name) {
      toast.warn('Name required');
      return;
    }
    if (!form.sku) {
      toast.warn('SKU required');
      return;
    }
    setSaving(true);
    const payload = {
      ...form,
      categoryId: form.categoryId || null,
      costCents: Math.round(Number(form.costCents) * 100),
      priceCents: Math.round(Number(form.priceCents) * 100),
      weightGrams: Math.round(Number(form.weightGrams) || 0),
      tiers: form.tiers
        .filter((t) => t.tierName && t.priceCents !== '')
        .map((t) => ({
          ...t,
          priceCents: Math.round(Number(t.priceCents) * 100),
          minQty: Math.round(Number(t.minQty) || 1),
        })),
      barcodes: form.barcodes.filter((b) => b.barcode),
      uom: form.uom
        .filter((u) => u.uomName)
        .map((u) => ({
          ...u,
          priceOverrideCents: u.priceOverrideCents === '' ? null : Math.round(Number(u.priceOverrideCents) * 100),
        })),
      bundleComponents: form.bundleComponents
        .filter((c) => c.componentProductId)
        .map((c) => ({
          componentProductId: c.componentProductId,
          qtyRequired: Math.round(Number(c.qtyRequired) || 1),
        })),
    };
    try {
      if (editing?.id) await api.put(`/products/${editing.id}`, payload);
      else await api.post('/products', payload);
      toast.ok(editing?.id ? 'Product updated' : 'Product created');
      setEditing(null);
      load(search, catId);
    } catch (e) {
      if (e?.silent) return;
      toast.err(e.message);
    } finally {
      setSaving(false);
    }
  };

  const doAdjust = async () => {
    const productId = adjustForm.productId != null ? adjustForm.productId : adjusting?.id;
    if (productId == null) {
      toast.warn('Select a product to adjust');
      return;
    }
    const qty = Number(adjustForm.qty);
    if (!Number.isFinite(qty) || qty === 0) {
      toast.warn('Enter a non-zero quantity change');
      return;
    }
    try {
      await api.post('/inventory/adjust', {
        productId,
        qty,
        type: adjustForm.type,
        note: adjustForm.note,
        batchNo: adjustForm.batchNo || undefined,
      });
      toast.ok('Stock adjusted');
      setAdjusting(null);
      load(search, catId);
    } catch (e) {
      if (e?.silent) return;
      toast.err(e.message);
    }
  };

  const saveBatch = async () => {
    if (!newBatch.batchNo) {
      toast.warn('Batch no required');
      return;
    }
    try {
      await api.post(`/products/${batchForm.id}/batches`, newBatch);
      toast.ok(`Batch ${newBatch.batchNo} added`);
      setBatchForm(null);
      setNewBatch({ batchNo: '', manufactureDate: '', expiryDate: '', qtyOnHand: 0, location: '' });
      load(search, catId);
    } catch (e) {
      if (e?.silent) return;
      toast.err(e.message);
    }
  };

  const printBarcode = (product) => {
    // Simple printable page with barcode text — replace with real barcode lib if available
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Barcode ${product.sku || product.id}</title>
      <style>body{font-family:Arial,Helvetica,sans-serif;padding:20px} .code{font-size:28px;font-weight:700;}</style></head><body>
      <div><div style="font-size:18px;font-weight:600">${product.name}</div>
      <div class="code">${product.barcode || product.sku || product.id}</div>
      <div style="margin-top:18px">Print this page to generate a barcode label.</div></div></body></html>`;
    const w = window.open('', '_blank', 'width=320,height=240');
    if (!w) return toast.warn('Pop-up blocked — allow pop-ups to print');
    w.document.write(html);
    w.document.close();
    setTimeout(() => {
      w.print();
      w.close();
    }, 300);
  };

  const addBarcodeRow = () => {
    if (!newBarcode.barcode) {
      toast.warn('Enter a barcode');
      return;
    }
    setForm({ ...form, barcodes: [...form.barcodes, { ...newBarcode, isPrimary: form.barcodes.length === 0 }] });
    setNewBarcode({ barcode: '', format: 'CODE128' });
  };

  // margin convenience
  const marginPct = (f) => {
    const c = Number(f.costCents) || 0,
      p = Number(f.priceCents) || 0;
    if (p <= 0) return 0;
    return Math.round(((p - c) / p) * 100);
  };

  const columns = [
    {
      key: 'thumb',
      label: 'Image',
      width: 90,
      render: (r) =>
        r.image_url ? (
          <div className="p-img">
            <img src={r.image_url} alt={r.name} />
          </div>
        ) : (
          <div className={`p-thumb${r.is_bundle ? ' kit' : ''}`}>{initials(r.name)}</div>
        ),
    },
    {
      key: 'name',
      label: 'Product & SKU',
      render: (r) => (
        <div className="cd">
          <div className="cd-txt">
            <div className="cd-nm">
              {r.name}
              {r.is_bundle ? <span className="kit-tag">Kit</span> : null}
            </div>
            <div className="cd-sub">
              <span className="mono">{r.sku || '—'}</span>
              {r.barcode ? ` · ${r.barcode}` : ''}
              {r.brand ? ` · ${r.brand}` : ''}
            </div>
          </div>
        </div>
      ),
    },
    { key: 'category', label: 'Category', render: (r) => <span className="muted">{r.category_name || '—'}</span> },
    {
      key: 'price',
      label: 'Selling price',
      num: true,
      render: (r) => <span className="price">{fmtMoney(r.price_cents)}</span>,
    },
    {
      key: 'stock',
      label: 'On-hand stock',
      num: true,
      render: (r) => (
        <div className="stock-cell">
          <span className={r.qty_on_hand <= 0 ? 'stock-qty danger' : 'stock-qty'}>{r.qty_on_hand}</span>
          {r.qty_on_hand <= 0 ? (
            <span className="badge badge-red">Out of stock</span>
          ) : r.qty_on_hand <= (r.reorder_level || 0) ? (
            <span className="badge badge-amber">Low</span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'actions',
      label: 'Actions',
      render: (r) => (
        <div className="row-actions">
          {can('catalog.manage') && (
            <button className="btn-link" onClick={() => openEdit(r)}>
              Edit
            </button>
          )}
          {can('catalog.manage') && (
            <button
              className="btn-link danger"
              onClick={async () => {
                if (!window.confirm(`Deactivate ${r.name}?`)) return;
                try {
                  await api.del(`/products/${r.id}`);
                  toast.ok('Product deactivated');
                  load(search, catId);
                } catch (e) {
                  if (e?.silent) return;
                  toast.err(e.message);
                }
              }}
            >
              Delete
            </button>
          )}
          <button className="btn-link" onClick={() => printBarcode(r)}>
            Barcode
          </button>
          {can('inventory.adjust') && (
            <button
              className="btn-link"
              onClick={() => {
                setAdjusting(r);
                setAdjustForm({ productId: r.id, qty: 0, type: 'ADJUST', note: '', batchNo: '' });
              }}
            >
              Adjust
            </button>
          )}
          {can('inventory.adjust') && r.serial_tracked && (
            <button
              className="btn-link"
              onClick={() => {
                setBatchForm(r);
                setNewBatch({
                  batchNo: '',
                  manufactureDate: '',
                  expiryDate: '',
                  qtyOnHand: 0,
                  location: r.bin_location || '',
                });
              }}
            >
              Batch
            </button>
          )}
        </div>
      ),
    },
  ];

  const activeCount = rows.filter((r) => r.active).length;
  const oosCount = rows.filter((r) => (r.qty_on_hand ?? 0) <= 0).length;
  const kitCount = rows.filter((r) => r.is_bundle).length;

  return (
    <div className="page">
      <div className="page-hd">
        <div className="page-title">
          <h1>Stock &amp; Products</h1>
          <p>Name, SKU and price are enough — the rest is optional.</p>
        </div>
      </div>
      <div className="toolbar">
        <button className="btn btn-primary" onClick={openNew} disabled={!can('catalog.manage')}>
          + New product
        </button>
        <input
          className="search-input"
          placeholder="Search name / SKU / barcode / brand / part #…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <CategorySelector
          value={catId}
          categories={cats}
          onChange={(v) => setCatId(v)}
          onAddCategory={createCategory}
          placeholder="All categories"
          canAdd={can('catalog.manage')}
        />
      </div>
      {loading ? (
        <div className="loader">
          <span className="spinner" />
          Loading catalog…
        </div>
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          empty="No products match."
          caption={
            <div className="stock-overview">
              <div className="so-count">
                <span className="so-num">{rows.length}</span>
                <span className="so-lbl">{rows.length === 1 ? 'product' : 'products'}</span>
              </div>
              <div className="so-badges">
                <span className="badge badge-green">{activeCount} active</span>
                <span className={`badge ${oosCount ? 'badge-red' : 'badge-gray'}`}>{oosCount} out of stock</span>
                {kitCount > 0 && (
                  <span className="badge badge-violet">
                    {kitCount} kit{kitCount === 1 ? '' : 's'}
                  </span>
                )}
              </div>
            </div>
          }
        />
      )}

      {/* ============ create / edit modal ============ */}
      {editing && (
        <Modal
          title={editing?.id ? `Edit — ${form.name || editing.name}` : 'New product'}
          onClose={() => setEditing(null)}
          wide
          footer={
            <div className="modal-actions">
              <button className="btn" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={save} disabled={saving}>
                {saving ? 'Saving…' : editing?.id ? 'Save changes' : 'Create product'}
              </button>
            </div>
          }
        >
          <div className="tabs-strip">
            {[
              ['general', 'Details'],
              ['advanced', 'Advanced'],
            ].map(([k, label]) => (
              <button key={k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>
                {label}
              </button>
            ))}
          </div>
          <div className="stock-tab">
            {tab === 'general' && (
              <>
                <div className="field">
                  <label>Name *</label>
                  <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </div>
                <div className="fields-2">
                  <div className="field">
                    <label>SKU *</label>
                    <input
                      value={form.sku}
                      onChange={(e) => setForm({ ...form, sku: e.target.value })}
                      disabled={!!editing?.id}
                    />
                  </div>
                  <div className="field">
                    <label>Barcode</label>
                    <input
                      className="mono"
                      value={form.barcode}
                      onChange={(e) => setForm({ ...form, barcode: e.target.value })}
                      placeholder="scan or type"
                    />
                  </div>
                </div>
                <div className="fields-3">
                  <div className="field">
                    <label>Cost</label>
                    <input
                      className="mono"
                      value={form.costCents}
                      onChange={(e) => setForm({ ...form, costCents: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label>Selling price</label>
                    <input
                      className="mono"
                      value={form.priceCents}
                      onChange={(e) => setForm({ ...form, priceCents: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label>Margin</label>
                    <div className="mono margin">{marginPct(form)}%</div>
                  </div>
                </div>
                <div className="fields-2">
                  <div className="field">
                    <label>Category</label>
                    <CategorySelector
                      value={form.categoryId}
                      categories={cats}
                      onChange={(v) => setForm({ ...form, categoryId: v })}
                      onAddCategory={createCategory}
                      placeholder="None"
                      canAdd={can('catalog.manage')}
                    />
                  </div>
                  <div className="field">
                    <label>Tax class</label>
                    <select value={form.taxClassId} onChange={(e) => setForm({ ...form, taxClassId: e.target.value })}>
                      {taxClasses.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} ({(t.rate_bps / 100).toFixed(1)}%)
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <p className="hint">Only the name, SKU and price are needed — everything else is optional.</p>
              </>
            )}

            {tab === 'advanced' && (
              <>
                <div className="sub-hd">About</div>
                <div className="field">
                  <label>Description</label>
                  <textarea
                    rows="3"
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                  />
                </div>
                <div className="fields-3">
                  <div className="field">
                    <label>Brand / Manufacturer</label>
                    <input value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} />
                  </div>
                  <div className="field">
                    <label>Base unit</label>
                    <select value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })}>
                      {UOM_NAMES.map((u) => (
                        <option key={u} value={u}>
                          {u}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label>Status</label>
                    <select
                      value={form.active ? 1 : 0}
                      onChange={(e) => setForm({ ...form, active: e.target.value === '1' })}
                    >
                      <option value={1}>Active</option>
                      <option value={0}>Inactive</option>
                    </select>
                  </div>
                </div>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={form.serialTracked}
                    onChange={(e) => setForm({ ...form, serialTracked: e.target.checked })}
                  />{' '}
                  Batch / serial-tracked
                </label>

                <div className="sub-hd">Pricing tiers</div>
                {form.tiers.map((t, i) => (
                  <div className="fields-3" key={i}>
                    <div className="field">
                      <input
                        placeholder="Tier name"
                        value={t.tierName}
                        onChange={(e) => setTier(i, 'tierName', e.target.value)}
                        list="tier-names"
                      />
                    </div>
                    <div className="field">
                      <input
                        className="mono"
                        placeholder="Price"
                        value={t.priceCents}
                        onChange={(e) => setTier(i, 'priceCents', e.target.value)}
                      />
                    </div>
                    <div className="field">
                      <input
                        type="number"
                        placeholder="Min qty"
                        value={t.minQty}
                        onChange={(e) => setTier(i, 'minQty', e.target.value)}
                      />
                    </div>
                  </div>
                ))}
                <datalist id="tier-names">
                  {TIER_NAMES.map((n) => (
                    <option key={n} value={n} />
                  ))}
                </datalist>
                <button className="btn btn-ghost btn-sm" onClick={addTier}>
                  + Add tier
                </button>

                <div className="sub-hd">Stock</div>
                <div className="fields-4">
                  <div className="field">
                    <label>Bin / shelf location</label>
                    <input
                      value={form.binLocation}
                      onChange={(e) => setForm({ ...form, binLocation: e.target.value })}
                      placeholder="e.g. A-01-03"
                    />
                  </div>
                  <div className="field">
                    <label>Reorder level</label>
                    <input
                      type="number"
                      value={form.reorderLevel}
                      onChange={(e) => setForm({ ...form, reorderLevel: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label>Min stock</label>
                    <input
                      type="number"
                      value={form.minStock}
                      onChange={(e) => setForm({ ...form, minStock: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label>Max stock</label>
                    <input
                      type="number"
                      value={form.maxStock}
                      onChange={(e) => setForm({ ...form, maxStock: e.target.value })}
                    />
                  </div>
                </div>

                <div className="sub-hd">Dimensions &amp; warranty</div>
                <div className="fields-4">
                  <div className="field">
                    <label>Weight (g)</label>
                    <input
                      type="number"
                      value={form.weightGrams}
                      onChange={(e) => setForm({ ...form, weightGrams: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label>Length (mm)</label>
                    <input
                      type="number"
                      value={form.lengthMm}
                      onChange={(e) => setForm({ ...form, lengthMm: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label>Width (mm)</label>
                    <input
                      type="number"
                      value={form.widthMm}
                      onChange={(e) => setForm({ ...form, widthMm: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label>Height (mm)</label>
                    <input
                      type="number"
                      value={form.heightMm}
                      onChange={(e) => setForm({ ...form, heightMm: e.target.value })}
                    />
                  </div>
                </div>
                <div className="fields-3">
                  <div className="field">
                    <label>Warranty (days)</label>
                    <input
                      type="number"
                      value={form.warrantyDays}
                      onChange={(e) => setForm({ ...form, warrantyDays: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label>Lead time (days)</label>
                    <input
                      type="number"
                      value={form.leadTimeDays}
                      onChange={(e) => setForm({ ...form, leadTimeDays: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label>Manufacturer part #</label>
                    <input
                      value={form.manufacturerPartNo}
                      onChange={(e) => setForm({ ...form, manufacturerPartNo: e.target.value })}
                    />
                  </div>
                </div>
                <div className="field">
                  <label>HS Code</label>
                  <input value={form.hsCode} onChange={(e) => setForm({ ...form, hsCode: e.target.value })} />
                </div>

                <div className="sub-hd">Extra barcodes</div>
                {form.barcodes.map((b, i) => (
                  <div className="fields-3" key={i}>
                    <input
                      className="mono"
                      value={b.barcode}
                      onChange={(e) => setBc(i, 'barcode', e.target.value)}
                      placeholder="barcode"
                    />
                    <select value={b.format} onChange={(e) => setBc(i, 'format', e.target.value)}>
                      {BC_FORMATS.map((f) => (
                        <option key={f} value={f}>
                          {f}
                        </option>
                      ))}
                    </select>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => setForm({ ...form, barcodes: form.barcodes.filter((_, x) => x !== i) })}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <div className="fields-3">
                  <input
                    className="mono"
                    value={newBarcode.barcode}
                    onChange={(e) => setNewBarcode({ ...newBarcode, barcode: e.target.value })}
                    placeholder="scan or type"
                  />
                  <select
                    value={newBarcode.format}
                    onChange={(e) => setNewBarcode({ ...newBarcode, format: e.target.value })}
                  >
                    {BC_FORMATS.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                  <button className="btn btn-ghost btn-sm" onClick={addBarcodeRow}>
                    + Add
                  </button>
                </div>

                <div className="sub-hd">Units of measure</div>
                {form.uom.map((u, i) => (
                  <div className="fields-4" key={i}>
                    <input
                      placeholder="UOM"
                      value={u.uomName}
                      onChange={(e) => setUomF(i, 'uomName', e.target.value)}
                      list="uom-names"
                    />
                    <input
                      type="number"
                      placeholder="× base"
                      value={u.conversionFactor}
                      onChange={(e) => setUomF(i, 'conversionFactor', e.target.value)}
                    />
                    <input
                      className="mono"
                      placeholder="Override price"
                      value={u.priceOverrideCents ?? ''}
                      onChange={(e) => setUomF(i, 'priceOverrideCents', e.target.value)}
                    />
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => setForm({ ...form, uom: form.uom.filter((_, x) => x !== i) })}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <datalist id="uom-names">
                  {UOM_NAMES.map((n) => (
                    <option key={n} value={n} />
                  ))}
                </datalist>
                <button className="btn btn-ghost btn-sm" onClick={addUom}>
                  + Add UOM
                </button>

                <div className="sub-hd">Bundle (kit)</div>
                <p className="hint">
                  A bundle sells as one line but pulls stock from its components. Use the component’s ID or SKU.
                </p>
                {form.bundleComponents.map((c, i) => (
                  <div className="fields-4" key={i}>
                    <input
                      placeholder="Component product ID or SKU"
                      value={c.componentProductId}
                      onChange={(e) => setComp(i, 'componentProductId', e.target.value)}
                    />
                    <input
                      type="number"
                      placeholder="Qty"
                      value={c.qtyRequired}
                      onChange={(e) => setComp(i, 'qtyRequired', e.target.value)}
                    />
                    <span className="muted mono">
                      {c.name || ''} {c.sku ? `(${c.sku})` : ''}
                    </span>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() =>
                        setForm({ ...form, bundleComponents: form.bundleComponents.filter((_, x) => x !== i) })
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button className="btn btn-ghost btn-sm" onClick={addBundleComp}>
                  + Add component
                </button>
              </>
            )}
          </div>
        </Modal>
      )}

      {/* adjust stock modal */}
      {adjusting && (
        <Modal
          title={`Adjust stock — ${adjusting.name}`}
          onClose={() => setAdjusting(null)}
          footer={
            <button className="btn btn-primary" onClick={doAdjust}>
              Apply adjustment
            </button>
          }
        >
          <div className="field">
            <label>Qty change (+/-)</label>
            <input
              type="number"
              value={adjustForm.qty}
              onChange={(e) => setAdjustForm({ ...adjustForm, qty: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Type</label>
            <select value={adjustForm.type} onChange={(e) => setAdjustForm({ ...adjustForm, type: e.target.value })}>
              <option value="ADJUST">Adjust</option>
              <option value="COUNT">Stock count</option>
              <option value="DAMAGED">Damaged</option>
              <option value="WRITE_OFF">Write-off</option>
            </select>
          </div>
          {adjusting.serial_tracked && (
            <div className="field">
              <label>Batch (optional, decrement specific batch)</label>
              <select
                value={adjustForm.batchNo || ''}
                onChange={(e) => setAdjustForm({ ...adjustForm, batchNo: e.target.value })}
              >
                <option value="">—</option>
                {(adjusting.batches || [])
                  .filter((b) => b.qty_on_hand > 0)
                  .map((b) => (
                    <option key={b.id} value={b.batch_no}>
                      {b.batch_no} ({b.qty_on_hand})
                    </option>
                  ))}
              </select>
            </div>
          )}
          <div className="field">
            <label>Note</label>
            <input value={adjustForm.note} onChange={(e) => setAdjustForm({ ...adjustForm, note: e.target.value })} />
          </div>
        </Modal>
      )}

      {/* add batch modal */}
      {batchForm && (
        <Modal
          title={`Add batch — ${batchForm.name}`}
          onClose={() => setBatchForm(null)}
          footer={
            <button className="btn btn-primary" onClick={saveBatch}>
              Add batch
            </button>
          }
        >
          <div className="field">
            <label>Batch / Lot no *</label>
            <input
              className="mono"
              value={newBatch.batchNo}
              onChange={(e) => setNewBatch({ ...newBatch, batchNo: e.target.value })}
            />
          </div>
          <div className="fields-2">
            <div className="field">
              <label>Manufacture date</label>
              <input
                type="date"
                value={newBatch.manufactureDate}
                onChange={(e) => setNewBatch({ ...newBatch, manufactureDate: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Expiry date</label>
              <input
                type="date"
                value={newBatch.expiryDate}
                onChange={(e) => setNewBatch({ ...newBatch, expiryDate: e.target.value })}
              />
            </div>
          </div>
          <div className="field">
            <label>Qty on hand (adds to stock)</label>
            <input
              type="number"
              value={newBatch.qtyOnHand}
              onChange={(e) => setNewBatch({ ...newBatch, qtyOnHand: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Location</label>
            <input value={newBatch.location} onChange={(e) => setNewBatch({ ...newBatch, location: e.target.value })} />
          </div>
        </Modal>
      )}
    </div>
  );
}
