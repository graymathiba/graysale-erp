// Catalog + inventory: products, categories, tax classes, extended product
// attributes (barcodes / price tiers / batches / UoM / bundles) and stock.

export function registerCatalog({ route, services: S, requireCap }) {
  const { catalog, auth } = S;

  route('GET', '/products', null, (ctx) =>
    ctx.json(
      catalog.listProducts({
        search: ctx.query.search,
        categoryId: ctx.query.categoryId,
        includeInactive: ctx.query.all === '1',
        tenantId: ctx.tenantId,
      }),
    ),
  );
  route('GET', '/products/low', null, (ctx) => ctx.json(catalog.lowStock(ctx.tenantId)));
  route('GET', '/products/search', null, (ctx) =>
    ctx.json({ q: ctx.query.q, results: catalog.listProducts({ search: ctx.query.q, tenantId: ctx.tenantId }) }),
  );
  route('GET', '/products/by-barcode/:barcode', null, (ctx) => {
    const p = catalog.findByBarcode(ctx.params.barcode, ctx.tenantId);
    return p ? ctx.json(p) : ctx.json({ error: 'NOT_FOUND' }, 404);
  });
  route('GET', '/products/:id', null, (ctx) => ctx.json(catalog.getProduct(ctx.params.id, ctx.tenantId)));
  route('POST', '/products', 'catalog.manage', async (ctx) => {
    requireCap('catalog.manage')(ctx);
    const b = await ctx.body();
    const product = catalog.createProduct({ ...b, userId: ctx.user.id, username: ctx.user.username }, ctx.tenantId);
    return ctx.json({ id: product.id, product }, 201);
  });
  route('PUT', '/products/:id', 'catalog.manage', async (ctx) => {
    requireCap('catalog.manage')(ctx);
    const b = await ctx.body();
    catalog.updateProduct(ctx.params.id, b, ctx.tenantId);
    auth.audit(ctx.user.id, ctx.user.username, 'PRODUCT_UPDATE', 'product', ctx.params.id, '');
    return ctx.json({ ok: true });
  });
  route('DELETE', '/products/:id', 'catalog.manage', async (ctx) => {
    requireCap('catalog.manage')(ctx);
    auth.audit(ctx.user.id, ctx.user.username, 'PRODUCT_DELETE', 'product', ctx.params.id, '');
    return ctx.json(catalog.deleteProduct(ctx.params.id, ctx.tenantId));
  });
  route('GET', '/categories', null, (ctx) => ctx.json(catalog.categories(ctx.tenantId)));
  route('POST', '/categories', 'catalog.manage', async (ctx) => {
    requireCap('catalog.manage')(ctx);
    const b = await ctx.body();
    return ctx.json({ id: catalog.createCategory(b.name, ctx.tenantId) }, 201);
  });
  route('GET', '/tax-classes', null, (ctx) => ctx.json(catalog.taxClasses()));

  // ----- product extended attributes -----
  route('GET', '/products/:id/barcodes', null, (ctx) => ctx.json(catalog.barcodes(ctx.params.id)));
  route('POST', '/products/:id/barcodes', 'catalog.manage', async (ctx) => {
    requireCap('catalog.manage')(ctx);
    const b = await ctx.body();
    return ctx.json({ id: catalog.addBarcode(ctx.params.id, b.barcode, b.format, b.isPrimary) }, 201);
  });
  route('DELETE', '/products/:id/barcodes/:bid', 'catalog.manage', async (ctx) => {
    requireCap('catalog.manage')(ctx);
    catalog.removeBarcode(ctx.params.bid);
    return ctx.json({ ok: true });
  });

  route('GET', '/products/:id/price-tiers', null, (ctx) => ctx.json(catalog.priceTiers(ctx.params.id)));
  route('PUT', '/products/:id/price-tiers', 'catalog.manage', async (ctx) => {
    requireCap('catalog.manage')(ctx);
    const b = await ctx.body();
    return ctx.json(catalog.setPriceTiers(ctx.params.id, b.tiers || []));
  });

  route('GET', '/products/:id/batches', null, (ctx) => ctx.json(catalog.batches(ctx.params.id)));
  route('POST', '/products/:id/batches', 'inventory.adjust', async (ctx) => {
    requireCap('inventory.adjust')(ctx);
    const b = await ctx.body();
    const id = catalog.addBatch(ctx.params.id, b);
    // Adding a batch with a starting qty also increases on-hand stock
    if (b.qtyOnHand && Number(b.qtyOnHand) > 0) {
      catalog.move({
        productId: ctx.params.id,
        qty: Math.round(Number(b.qtyOnHand)),
        type: 'RECEIPT',
        refType: 'batch',
        refId: id,
        note: `batch ${b.batchNo}`,
        userId: ctx.user.id,
      });
    }
    auth.audit(ctx.user.id, ctx.user.username, 'BATCH_CREATE', 'product', ctx.params.id, b.batchNo);
    return ctx.json({ id }, 201);
  });
  route('POST', '/products/:id/batches/fefo', 'pos.sell', async (ctx) => {
    requireCap('pos.sell')(ctx);
    const b = await ctx.body();
    return ctx.json({ allocated: catalog.fefoAllocate(ctx.params.id, Math.round(Number(b.qty))) });
  });

  route('GET', '/products/:id/uom', null, (ctx) => ctx.json(catalog.uomList(ctx.params.id)));
  route('PUT', '/products/:id/uom', 'catalog.manage', async (ctx) => {
    requireCap('catalog.manage')(ctx);
    const b = await ctx.body();
    return ctx.json(catalog.setUom(ctx.params.id, b.uom || []));
  });

  route('GET', '/products/:id/bundle', null, (ctx) =>
    ctx.json({ components: catalog.bundleComponents(ctx.params.id) }),
  );
  route('PUT', '/products/:id/bundle', 'catalog.manage', async (ctx) => {
    requireCap('catalog.manage')(ctx);
    const b = await ctx.body();
    return ctx.json(catalog.setBundle(ctx.params.id, b.components || []));
  });

  // ----- inventory -----
  route('GET', '/inventory/stock', 'inventory.view', (ctx) =>
    ctx.json(catalog.listProducts({ includeInactive: true, tenantId: ctx.tenantId })),
  );
  route('GET', '/inventory/movements', 'inventory.view', (ctx) =>
    ctx.json(catalog.movements({ productId: ctx.query.productId })),
  );
  route('POST', '/inventory/adjust', 'inventory.adjust', async (ctx) => {
    requireCap('inventory.adjust')(ctx);
    const b = await ctx.body();
    const q = catalog.move({
      productId: b.productId,
      qty: b.qty,
      type: b.type || 'ADJUST',
      note: b.note,
      userId: ctx.user.id,
      tenantId: ctx.tenantId,
      batchNo: b.batchNo || undefined,
    });
    auth.audit(
      ctx.user.id,
      ctx.user.username,
      'INVENTORY_ADJUST',
      'product',
      b.productId,
      `${b.type}:${b.qty} ${b.note || ''}`,
    );
    return ctx.json({ qtyOnHand: q });
  });
}
