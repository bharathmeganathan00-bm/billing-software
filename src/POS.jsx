import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  BarChart3,
  Bell,
  Boxes,
  Cable,
  CreditCard,
  Download,
  FileSpreadsheet,
  FileText,
  Headphones,
  History,
  Image,
  LogOut,
  Minus,
  Pencil,
  PlugZap,
  Plus,
  Power,
  Printer,
  ReceiptText,
  RefreshCw,
  Search,
  ShoppingCart,
  Smartphone,
  TabletSmartphone,
  Tags,
  Trash2,
  UserCog,
  WalletCards,
  Wrench
} from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, PieChart, Pie, Cell } from "recharts";
import api from "./api.js";
import { printReceipt } from "./electron.js";

const currency = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 2
});

const now = new Date();
const tzOffset = now.getTimezoneOffset() * 60000;
const today = new Date(now.getTime() - tzOffset).toISOString().slice(0, 10);
const defaultFrom = new Date(now.getTime() - tzOffset - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const categoryIconMap = {
  accessories: Cable,
  accessory: Cable,
  chargers: PlugZap,
  charger: PlugZap,
  service: Wrench,
  repair: Wrench,
  repairs: Wrench,
  mobiles: Smartphone,
  mobile: Smartphone,
  phones: Smartphone,
  phone: Smartphone,
  gadgets: Headphones,
  gadget: Headphones,
  electronics: Power,
  electronic: Power
};

function iconForCategory(category = "") {
  return categoryIconMap[category.toLowerCase()] || TabletSmartphone;
}

export default function POS({ session, onLogout }) {
  const isAdmin = session.user.role === "admin";
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [dashboard, setDashboard] = useState(null);
  const [cart, setCart] = useState([]);
  const [customer, setCustomer] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [gstNumber, setGstNumber] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [paper, setPaper] = useState("80mm");
  const [activeView, setActiveView] = useState("pos");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [reprintPending, setReprintPending] = useState(false);
  const [viewPngPending, setViewPngPending] = useState(false);
  const [showGlobalPreview, setShowGlobalPreview] = useState(false);
  const [capturingPng, setCapturingPng] = useState(false);
  const receiptRef = useRef(null);
  const [justCheckedOut, setJustCheckedOut] = useState(false);
  const [receipt, setReceipt] = useState({
    billNumber: null,
    printCount: 0,
    items: [],
    subtotal: 0,
    tax: 0,
    total: 0,
    customer: "",
    phone: "",
    address: "",
    gstNumber: "",
    date: ""
  });

  async function loadData() {
    const [productsResponse, dashboardResponse, categoriesResponse] = await Promise.all([
      api.get("/products", { params: { includeInactive: isAdmin ? 1 : 0 } }),
      api.get("/dashboard", { params: { from: today, to: today } }),
      api.get("/categories")
    ]);
    setProducts(productsResponse.data);
    setDashboard(dashboardResponse.data);
    setCategories(categoriesResponse.data);
  }

  useEffect(() => {
    loadData().catch((error) => setMessage(error.response?.data?.error || "Could not load POS data"));
  }, []);

  // Auto WhatsApp low-stock alert after checkout
  useEffect(() => {
    if (!justCheckedOut) return;
    setJustCheckedOut(false);
    const lowStock = products.filter(p => p.active !== false && p.stock >= 0 && p.stock <= p.low_stock_threshold);
    if (!lowStock.length) return;
    let alerts;
    try { alerts = JSON.parse(localStorage.getItem("pos_wa_alerts") || "[]"); } catch { alerts = []; }
    if (!alerts.length) return;
    api.post("/notify/lowstock", { alerts, products: lowStock })
      .then(r => setMessage(`📲 WhatsApp alert sent to ${r.data.sent} number(s) — ${lowStock.length} low stock item(s).`))
      .catch(() => {});
  }, [products, justCheckedOut]);

  const subtotal = cart.reduce((sum, item) => sum + (item.price - (item.discount || 0)) * item.qty, 0);
  const cgstTotal = Number(cart.reduce((sum, item) => {
    const eff = item.price - (item.discount || 0);
    return sum + eff * item.qty * ((item.cgst ?? 9) / 100);
  }, 0).toFixed(2));
  const sgstTotal = Number(cart.reduce((sum, item) => {
    const eff = item.price - (item.discount || 0);
    return sum + eff * item.qty * ((item.sgst ?? 9) / 100);
  }, 0).toFixed(2));
  const tax = Number((cgstTotal + sgstTotal).toFixed(2));
  const total = Number((subtotal + tax).toFixed(2));

  const activeProductsCount = products.filter((item) => item.active).length;
  const todaySalesCount = dashboard?.summary?.orders || 0;

  function addToCart(product) {
    if (product.stock <= 1) return;
    setCart((current) => {
      const existing = current.find((item) => item.product_id === product.id);
      if (!existing) {
        return [
          ...current,
          { product_id: product.id, name: product.name, price: product.price, qty: 1, stock: product.stock, discount: 0, description: "", cgst: 9, sgst: 9 }
        ];
      }
      if (existing.qty >= product.stock) return current;
      return current.map((item) =>
        item.product_id === product.id ? { ...item, qty: item.qty + 1 } : item
      );
    });
  }

  function updateItemField(productId, field, value) {
    setCart((current) =>
      current.map((item) =>
        item.product_id === productId ? { ...item, [field]: value } : item
      )
    );
  }

  function updateQty(productId, delta) {
    setCart((current) =>
      current
        .map((item) => item.product_id === productId ? {
          ...item,
          qty: Math.max(0, Math.min(item.stock, item.qty + delta))
        } : item)
        .filter((item) => item.qty > 0)
    );
  }

  async function checkout(taxMode) {
    if (cart.length === 0) {
      setMessage("Add at least one item before charging.");
      return;
    }

    setBusy(true);
    setMessage("");
    try {
      const response = await api.post("/sales", {
        items: cart,
        customer,
        phone,
        address,
        gstNumber,
        payment_method: paymentMethod,
        tax_mode: taxMode
      });
      const sale = response.data.sale;
      const completedReceipt = {
        billNumber: sale.bill_number,
        printCount: 1,
        items: [...cart],
        subtotal: sale.subtotal,
        tax: sale.tax,
        total: sale.total,
        customer,
        phone,
        address,
        gstNumber,
        date: new Date().toLocaleString()
      };
      setReceipt(completedReceipt);
      setCart([]);
      setCustomer("");
      setPhone("");
      setAddress("");
      setGstNumber("");
      setJustCheckedOut(true);
      await loadData();
      setTimeout(async () => {
        await printReceipt(paper);
        setReceipt({
          billNumber: null,
          printCount: 0,
          items: [],
          subtotal: 0,
          tax: 0,
          total: 0,
          customer: "",
          phone: "",
          address: "",
          gstNumber: "",
          date: ""
        });
      }, 150);
    } catch (error) {
      setMessage(error.response?.data?.error || "Checkout failed");
    } finally {
      setBusy(false);
    }
  }

  async function reprintSale(saleId) {
    try {
      const response = await api.get(`/sales/${saleId}`);
      const saleData = response?.data;
      if (!saleData) {
        console.error("[POS] Sale not found:", saleId);
        setMessage({ type: "error", text: "Sale not found" });
        return;
      }
      setReceipt({
        billNumber: saleData.bill_number,
        bill_number: saleData.bill_number,
        printCount: 0,
        items: saleData.items,
        subtotal: Number(saleData.subtotal),
        tax: Number(saleData.tax),
        total: Number(saleData.total),
        customer: saleData.customer || "",
        phone: saleData.phone || "",
        address: saleData.address || "",
        gstNumber: saleData.gst_number || "",
        payment_method: saleData.payment_method,
        date: new Date(saleData.created_at).toLocaleString()
      });
      setShowGlobalPreview(true);
    } catch (e) {
      setMessage("Could not load sale for reprint.");
    }
  }

  async function viewBillAsPng(saleId) {
    try {
      const response = await api.get(`/sales/${saleId}`);
      const saleData = response?.data;
      if (!saleData) {
        console.error("[POS] Sale not found:", saleId);
        setMessage({ type: "error", text: "Sale not found" });
        return;
      }
      setReceipt({
        billNumber: saleData.bill_number,
        bill_number: saleData.bill_number,
        printCount: 0,
        items: saleData.items,
        subtotal: Number(saleData.subtotal),
        tax: Number(saleData.tax),
        total: Number(saleData.total),
        customer: saleData.customer || "",
        phone: saleData.phone || "",
        address: saleData.address || "",
        gstNumber: saleData.gst_number || "",
        payment_method: saleData.payment_method,
        date: new Date(saleData.created_at).toLocaleString()
      });
      setShowGlobalPreview(true);
    } catch (e) {
      setMessage("Could not load sale for PNG view.");
    }
  }

  const views = [
    ["pos", "Billing", ShoppingCart, true],
    ["dashboard", "Dashboard", BarChart3, true],
    ["products", "Products", Boxes, true],
    ["categories", "Categories", Tags, true],
    ["staff", "Staff", UserCog, isAdmin],
    ["customers", "Customers", History, true],
    ["reports", "Reports", FileText, true],
    ["expenses", "Expenses", WalletCards, isAdmin],
    ["alerts", "Alerts", Bell, true]
  ];

  return (
    <main className={`app-shell paper-${paper}`}>
      <aside className="sidebar">
        <div className="shop-title">
          <img src="./vm-logo.png" alt="VM Logo" style={{ height: "52px", width: "auto", objectFit: "contain" }} />
          <span>Vedha Mobiles</span>
        </div>
        {views.filter((view) => view[3]).map(([id, label, Icon]) => (
          <button key={id} className={activeView === id ? "nav-active" : ""} onClick={() => setActiveView(id)}>
            <Icon size={18} />
            {label}
          </button>
        ))}
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <strong>{activeView === "pos" ? "Billing Counter" : activeView}</strong>
            <span>{session.user.username} - {session.user.role}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div className="status-pill">
              Sales Today: {todaySalesCount} &nbsp;|&nbsp; Products: {activeProductsCount}
            </div>
            <button onClick={() => window.location.reload()} className="topbar-refresh-btn" title="Refresh Page">
              <RefreshCw size={20} />
            </button>
            <button onClick={onLogout} className="topbar-logout-btn" title="Logout">
              <LogOut size={20} />
            </button>
          </div>
        </header>

        {activeView === "pos" ? (
        <BillingView
            categories={categories}
            products={products.filter(p => p.active)}
            addToCart={addToCart}
            cart={cart}
            updateQty={updateQty}
            updateItemField={updateItemField}
            customer={customer}
            setCustomer={setCustomer}
            phone={phone}
            setPhone={setPhone}
            address={address}
            setAddress={setAddress}
            gstNumber={gstNumber}
            setGstNumber={setGstNumber}
            subtotal={subtotal}
            cgstTotal={cgstTotal}
            sgstTotal={sgstTotal}
            tax={tax}
            total={total}
            paymentMethod={paymentMethod}
            setPaymentMethod={setPaymentMethod}
            paper={paper}
            setPaper={setPaper}
            checkout={checkout}
            busy={busy}
            receipt={receipt}
            setReceipt={setReceipt}
            reprintPending={reprintPending}
            clearReprintPending={() => setReprintPending(false)}
            viewPngPending={viewPngPending}
            clearViewPngPending={() => setViewPngPending(false)}
            setShowGlobalPreview={setShowGlobalPreview}
          />
        ) : null}
        {activeView === "dashboard" ? <Dashboard dashboard={dashboard} /> : null}
        {activeView === "products" ? (
          <ProductsAdmin products={products} categories={categories} reload={loadData} setMessage={setMessage} isAdmin={isAdmin} />
        ) : null}
        {activeView === "categories" ? <CategoriesAdmin reload={loadData} setMessage={setMessage} isAdmin={isAdmin} /> : null}
        {activeView === "staff" && isAdmin ? <StaffAdmin setMessage={setMessage} /> : null}
        {activeView === "customers" ? <Customers onReprint={reprintSale} onViewPng={viewBillAsPng} paper={paper} /> : null}
        {activeView === "reports" ? <Reports /> : null}
        {activeView === "expenses" && isAdmin ? <Expenses setMessage={setMessage} isAdmin={isAdmin} /> : null}
        {activeView === "alerts" ? <AlertsPage products={products} /> : null}
      </section>

      {/* The hidden receipt that actually gets printed by the browser window.print() */}
      <div className={`paper-${paper}`}>
        <Receipt
          paper={paper}
          receipt={receipt.billNumber ? receipt : {
            ...receipt,
            items: cart,
            subtotal: subtotal,
            tax: tax,
            total: total,
            customer: customer,
            phone: phone,
            address: address,
            gstNumber: gstNumber,
            date: new Date().toLocaleString()
          }}
        />
      </div>

      {/* Global Print Preview Modal */}
      {showGlobalPreview && (
        <div className="preview-modal-overlay" style={{ zIndex: 9999 }}>
          <div className="preview-modal-content">
            <div className="preview-modal-actions">
              <button className="secondary-button" onClick={() => setShowGlobalPreview(false)}>Close</button>
              <button
                className="secondary-button"
                onClick={async () => {
                  if (!receiptRef.current || !window.posPrinter?.captureReceiptPng) return;
                  setCapturingPng(true);
                  try {
                    const rect = receiptRef.current.getBoundingClientRect();
                    await window.posPrinter.captureReceiptPng({
                      x: rect.left, y: rect.top,
                      width: rect.width, height: rect.height
                    });
                  } finally {
                    setCapturingPng(false);
                  }
                }}
                disabled={capturingPng}
                style={{display:"flex",gap:"6px",alignItems:"center"}}
              >
                <Image size={15} />
                {capturingPng ? "Capturing…" : "Save as PNG"}
              </button>
              <button className="primary-button" onClick={() => {
                setShowGlobalPreview(false);
                setTimeout(() => printReceipt(paper), 150);
              }}>Print</button>
            </div>
            <div className={`paper-${paper} preview-container`} ref={receiptRef}>
              <Receipt
                paper={paper}
                receipt={receipt}
              />
            </div>
          </div>
        </div>
      )}

      {/* Toast rendered outside workspace so it never affects workspace flex layout */}
      <CustomToast message={message} onClose={() => setMessage("")} />
    </main>
  );
}

function BillingView(props) {
  const [query, setQuery] = useState("");
  const [categoryPath, setCategoryPath] = useState([]);

  const currentCat = categoryPath.length > 0 ? categoryPath[categoryPath.length - 1] : null;
  const visibleCats = currentCat
    ? props.categories.filter(c => c.parent_id === currentCat.id)
    : props.categories.filter(c => !c.parent_id);
  const currentHasChildren = visibleCats.length > 0;

  const leafCatId = (currentCat && !currentHasChildren) ? currentCat.id : null;
  const filteredProducts = (() => {
    if (query.trim()) {
      const t = query.trim().toLowerCase();
      return props.products.filter(p => [p.name || "", p.category_name || ""].join(" ").toLowerCase().includes(t));
    }
    if (leafCatId) return props.products.filter(p => p.category_id === leafCatId);
    return [];
  })();

  const showProducts = query.trim() !== "" || leafCatId !== null;

  function handleCategoryClick(cat) {
    setQuery("");
    setCategoryPath(prev => [...prev, cat]);
  }
  function handleBreadcrumb(index) {
    setCategoryPath(prev => prev.slice(0, index + 1));
  }
  function handleRoot() {
    setQuery("");
    setCategoryPath([]);
  }

  function prepareReceiptForPrint() {
    props.setReceipt((current) => ({
      ...current,
      printCount: current.billNumber ? current.printCount + 1 : current.printCount,
      items: current.billNumber ? current.items : props.cart,
      subtotal: current.billNumber ? current.subtotal : props.subtotal,
      tax: current.billNumber ? current.tax : props.tax,
      total: current.billNumber ? current.total : props.total,
      customer: current.billNumber ? current.customer : props.customer,
      phone: current.billNumber ? current.phone : props.phone,
      date: current.date || new Date().toLocaleString()
    }));
  }

  function printCurrentReceipt() {
    props.setShowGlobalPreview(false);
    setTimeout(() => printReceipt(props.paper), 150);
  }

  return (
    <div className="pos-layout">
      <section className="catalog">
        <div className="search-box">
          <Search size={18} />
          <input
            value={query}
            placeholder="Search products or categories"
            onChange={(e) => { setQuery(e.target.value); if (e.target.value) setCategoryPath([]); }}
          />
        </div>

        {/* Breadcrumb navigation */}
        {!query && categoryPath.length > 0 && (
          <div className="category-breadcrumb">
            <button className="breadcrumb-btn" onClick={handleRoot}>All</button>
            {categoryPath.map((cat, i) => (
              <span key={cat.id} className="breadcrumb-segment">
                <span className="breadcrumb-sep">›</span>
                <button
                  className={`breadcrumb-btn${i === categoryPath.length - 1 ? " breadcrumb-current" : ""}`}
                  onClick={() => handleBreadcrumb(i)}
                >{cat.name}</button>
              </span>
            ))}
          </div>
        )}

        <div className="product-grid">
          {showProducts ? (
            filteredProducts.length === 0
              ? <div style={{color:"#94a3b8",padding:"20px",gridColumn:"1/-1"}}>No products found.</div>
              : filteredProducts.map(product => (
                  <ProductCard key={product.id} product={product} addToCart={props.addToCart} />
                ))
          ) : (
            visibleCats.map(cat => (
              <div key={cat.id} className="category-card" onClick={() => handleCategoryClick(cat)}>
                <div className="category-icon"><Tags size={32} /></div>
                <div className="category-name">{cat.name}</div>
                {props.categories.some(c => c.parent_id === cat.id) && (
                  <div className="category-sub-badge">Has subcategories</div>
                )}
              </div>
            ))
          )}
        </div>
      </section>

      <aside className="cart-panel">
        <div className="customer-grid">
          <input value={props.customer} placeholder="Customer" onChange={(event) => props.setCustomer(event.target.value)} />
          <input value={props.phone} placeholder="Phone" onChange={(event) => props.setPhone(event.target.value)} />
          <input value={props.address} placeholder="Address" onChange={(event) => props.setAddress(event.target.value)} />
          <input value={props.gstNumber} placeholder="GST Number" onChange={(event) => props.setGstNumber(event.target.value)} />
        </div>
        <div className="cart-list">
          {props.cart.length === 0 ? <div className="empty-cart">Cart is empty</div> : props.cart.map((item) => {
            const effectivePrice = item.price - (item.discount || 0);
            return (
              <div className="cart-row cart-row-expanded" key={item.product_id}>
                <div className="cart-row-top">
                  <div className="cart-row-name">
                    <strong>{item.name}</strong>
                    <span className="cart-price-line">
                      {item.discount > 0 && <s style={{color:"#64748b",fontSize:"11px"}}>{currency.format(item.price)}</s>}
                      <span style={{color: item.discount > 0 ? "#22c55e" : "#94a3b8"}}>{currency.format(effectivePrice)}</span>
                    </span>
                  </div>
                  <div className="qty-controls">
                    <button onClick={() => props.updateQty(item.product_id, -1)}><Minus size={14} /></button>
                    <span>{item.qty}</span>
                    <button onClick={() => props.updateQty(item.product_id, 1)}><Plus size={14} /></button>
                    <button onClick={() => props.updateQty(item.product_id, -item.qty)}><Trash2 size={14} /></button>
                  </div>
                </div>
                <div className="cart-row-extras" style={{ gridTemplateColumns: "1fr 1fr 60px 60px" }}>
                  <input
                    className="cart-extra-input"
                    type="number"
                    min="0"
                    placeholder="Discount ₹"
                    value={item.discount || ""}
                    onChange={(e) => props.updateItemField(item.product_id, "discount", Number(e.target.value) || 0)}
                  />
                  <input
                    className="cart-extra-input"
                    type="text"
                    placeholder="Description"
                    value={item.description || ""}
                    onChange={(e) => props.updateItemField(item.product_id, "description", e.target.value)}
                  />
                  <input
                    className="cart-extra-input"
                    type="number"
                    min="0"
                    max="100"
                    placeholder="CGST%"
                    value={item.cgst ?? 9}
                    onChange={(e) => props.updateItemField(item.product_id, "cgst", Number(e.target.value) >= 0 ? Number(e.target.value) : 9)}
                    title="CGST %"
                  />
                  <input
                    className="cart-extra-input"
                    type="number"
                    min="0"
                    max="100"
                    placeholder="SGST%"
                    value={item.sgst ?? 9}
                    onChange={(e) => props.updateItemField(item.product_id, "sgst", Number(e.target.value) >= 0 ? Number(e.target.value) : 9)}
                    title="SGST %"
                  />
                </div>
              </div>
            );
          })}
        </div>
        <div className="totals">
          <div><span>Subtotal</span><strong>{currency.format(props.subtotal)}</strong></div>
          <div><span>CGST</span><strong>{currency.format(props.cgstTotal)}</strong></div>
          <div><span>SGST</span><strong>{currency.format(props.sgstTotal)}</strong></div>
          <div className="grand-total"><span>Total</span><strong>{currency.format(props.total)}</strong></div>
        </div>
        <div className="checkout-options">
          <select value={props.paymentMethod} onChange={(event) => props.setPaymentMethod(event.target.value)}>
            <option value="cash">Cash</option>
            <option value="card">Card</option>
            <option value="upi">UPI</option>
          </select>
          <select value={props.paper} onChange={(event) => props.setPaper(event.target.value)}>
            <option value="80mm">80mm</option>
            <option value="A4">A4</option>
            <option value="A5">A5</option>
          </select>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <button className="charge-button pos-action-btn" onClick={() => props.checkout("none")} disabled={props.busy} style={{ background: "#475569" }}>
            <CreditCard size={16} />
            {props.busy ? "Charging..." : "Charge 1 (No Tax)"}
          </button>
          <button className="charge-button pos-action-btn" onClick={() => props.checkout("inclusive")} disabled={props.busy} style={{ background: "#0ea5e9" }}>
            <CreditCard size={16} />
            {props.busy ? "Charging..." : "Charge 2 (Incl. GST)"}
          </button>
          <button className="charge-button pos-action-btn" onClick={() => props.checkout("exclusive")} disabled={props.busy} style={{ background: "#22c55e" }}>
            <CreditCard size={16} />
            {props.busy ? "Charging..." : "Charge 3 (Excl. GST)"}
          </button>
        </div>
        <button className="secondary-button pos-action-btn" onClick={() => { prepareReceiptForPrint(); props.setShowGlobalPreview(true); }}>
          <Printer size={16} />
          Print Preview
        </button>
      </aside>
    </div>
  );
}

function ProductCard({ product, addToCart }) {
  const Icon = iconForCategory(product.category_name || product.category);

  return (
    <button
      className="product-card"
      onClick={() => addToCart(product)}
      disabled={product.stock <= 1}
    >
      <div className="product-card-top">
        <span className="product-icon"><Icon size={24} /></span>
        <span className="product-category">{product.category_name || product.category}</span>
      </div>
      <strong>{product.name}</strong>
      <span>{currency.format(product.price)}</span>
      <small>{product.stock > 0 ? `${product.stock} in stock` : "Out of stock"}</small>
      {product.location && (
        <small style={{
          display: "flex", alignItems: "center", gap: "3px",
          color: "#7dd3fc", marginTop: "2px", fontSize: "10px", fontWeight: 600
        }}>
          📍 {product.location}
        </small>
      )}
    </button>
  );
}

function ProductsAdmin({ products, categories, reload, setMessage, isAdmin }) {
  const parents = categories.filter(c => !c.parent_id);
  const hasChildrenSet = new Set(categories.filter(c => c.parent_id).map(c => c.parent_id));
  const leafParents = parents.filter(p => !hasChildrenSet.has(p.id));
  const defaultCategoryId = leafParents.length > 0 ? leafParents[0].id : (categories.find(c => c.name === 'General')?.id || null);
  const blank = { name: "", category_id: defaultCategoryId, price: "", stock: "", low_stock_threshold: 5, location: "" };
  const [form, setForm] = useState(blank);
  const [editingId, setEditingId] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");

  const filteredAdminProducts = products.filter((p) => {
    if (!p.active) return false;
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      (p.name || "").toLowerCase().includes(q) ||
      (p.category_name || "").toLowerCase().includes(q) ||
      (p.location || "").toLowerCase().includes(q)
    );
  });

  function edit(product) {
    setEditingId(product.id);
    setForm({
      name: product.name,
      category_id: product.category_id,
      price: product.price,
      stock: product.stock,
      low_stock_threshold: product.low_stock_threshold,
      location: product.location || ""
    });
  }

  async function save(event) {
    event.preventDefault();
    const payload = {
      ...form,
      price: Number(form.price),
      stock: Number(form.stock),
      low_stock_threshold: Number(form.low_stock_threshold)
    };
    try {
      if (editingId) {
        await api.patch(`/products/${editingId}`, payload);
        setMessage("Product updated.");
      } else {
        await api.post("/products", payload);
        setMessage("Product added.");
      }
      setForm(blank);
      setEditingId(null);
      await reload();
    } catch (error) {
      const errText = error.response?.data?.error || "Failed to save product.";
      if (errText.includes("duplicate key") || errText.includes("already exists")) {
        setMessage("A product with this name already exists!");
      } else {
        setMessage(errText);
      }
    }
  }

  async function remove(id) {
    if (!confirm("Delete this product from billing?")) return;
    await api.delete(`/products/${id}`);
    setMessage("Product deleted.");
    await reload();
  }

  return (
    <section className="admin-layout">
      <form className="content-panel form-grid" onSubmit={save}>
        <input placeholder="Product name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <select value={form.category_id || ""} onChange={(e) => setForm({ ...form, category_id: Number(e.target.value) || null })}>
          {parents.map(p => {
            const kids = categories.filter(c => c.parent_id === p.id);
            if (kids.length === 0) {
              return <option key={p.id} value={p.id}>{p.name}</option>;
            }
            return (
              <optgroup key={p.id} label={p.name}>
                {kids.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}
              </optgroup>
            );
          })}
        </select>
        <input type="number" min="0" placeholder="Price" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
        <input type="number" min="0" placeholder="Stock" value={form.stock} onChange={(e) => setForm({ ...form, stock: e.target.value })} />
        <input type="number" min="0" placeholder="Low stock alert" value={form.low_stock_threshold} onChange={(e) => setForm({ ...form, low_stock_threshold: e.target.value })} />
        <input placeholder="Shop location (e.g. Shelf A3, Counter 2)" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
        <button className="primary-button">{editingId ? "Update Product" : "Add Product"}</button>
      </form>

      <div className="search-box admin-search" style={{ marginBottom: "16px" }}>
        <Search size={18} />
        <input
          placeholder="Search products by name or category..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      <DataTable
        columns={["Name", "Category", "Location", "Price", "Stock", "Actions"]}
        rows={filteredAdminProducts.map((product) => [
          product.name,
          product.category_name || product.category,
          product.location
            ? <span style={{background:"#1e3a5f",color:"#7dd3fc",borderRadius:"4px",padding:"2px 8px",fontSize:"11px",fontWeight:600}}>📍 {product.location}</span>
            : <span style={{color:"#475569",fontSize:"11px"}}>—</span>,
          currency.format(product.price),
          product.stock,
          <span className="row-actions" key={product.id}>
            <button onClick={() => edit(product)}><Pencil size={15} /></button>
            {isAdmin && (
              <button onClick={() => remove(product.id)}><Trash2 size={15} /></button>
            )}
          </span>
        ])}
      />
    </section>
  );
}

function AlertsPage({ products }) {
  return (
    <section className="admin-layout">
      <div className="content-panel" style={{ maxWidth: "560px" }}>
        <h2 style={{ margin: "0 0 18px", fontSize: "18px", color: "#e2e8f0", display: "flex", alignItems: "center", gap: "8px" }}>
          <Bell size={20} color="#22c55e" /> WhatsApp Low Stock Alerts
        </h2>
        <p style={{ fontSize: "12px", color: "#64748b", marginBottom: "18px", lineHeight: "1.6" }}>
          Save WhatsApp numbers below. When any product reaches its low stock limit, click the green button to send an alert to all saved numbers instantly.
        </p>
        <WhatsAppAlerts products={products} />
      </div>
    </section>
  );
}

function WhatsAppAlerts({ products }) {
  const [numbers, setNumbers] = useState(() => {
    try { return JSON.parse(localStorage.getItem("pos_wa_numbers") || "[]"); }
    catch { return []; }
  });
  const [newNumber, setNewNumber] = useState("");
  const lowStock = products.filter(p => p.active !== false && p.stock >= 0 && p.stock <= p.low_stock_threshold);

  function saveNumbers(updated) {
    setNumbers(updated);
    localStorage.setItem("pos_wa_numbers", JSON.stringify(updated));
  }

  function addNumber() {
    const phone = newNumber.replace(/\D/g, "");
    if (!phone || phone.length < 10) return;
    if (numbers.includes(phone)) return;
    saveNumbers([...numbers, phone]);
    setNewNumber("");
  }

  function sendAlerts() {
    if (!lowStock.length || !numbers.length) return;
    const message = encodeURIComponent(
      `⚠️ Low Stock Alert - Vedha Mobiles\n\n` +
      lowStock.map(p => `• ${p.name}: ${p.stock} remaining (min: ${p.low_stock_threshold})`).join("\n") +
      `\n\nPlease restock soon.`
    );
    numbers.forEach((phone, i) => {
      setTimeout(() => {
        window.open(`https://wa.me/${phone}?text=${message}`, "_blank");
      }, i * 800);
    });
  }

  const sBtn = { background: "transparent", border: "none", color: "#ef4444", cursor: "pointer", fontSize: "15px", padding: "0 4px" };

  return (
    <div className="content-panel" style={{ display: "grid", gap: "10px" }}>
      <div style={{ fontWeight: 700, fontSize: "13px", color: "#e2e8f0" }}>📲 WhatsApp Low Stock Alerts</div>

      {lowStock.length > 0 && (
        <div style={{ background: "#451a1a", border: "1px solid #ef4444", borderRadius: "6px", padding: "10px" }}>
          <div style={{ color: "#fca5a5", fontWeight: 700, marginBottom: "6px" }}>
            ⚠️ {lowStock.length} product{lowStock.length > 1 ? "s" : ""} at low stock:
          </div>
          {lowStock.map(p => (
            <div key={p.id} style={{ color: "#fecaca", fontSize: "12px", marginBottom: "2px" }}>
              • {p.name}: <strong>{p.stock}</strong> remaining (min: {p.low_stock_threshold})
            </div>
          ))}
          {numbers.length > 0 && (
            <button
              onClick={sendAlerts}
              style={{ marginTop: "10px", background: "#25D366", color: "#fff", border: "none", borderRadius: "6px", padding: "7px 14px", fontWeight: 700, fontSize: "13px", cursor: "pointer", display: "flex", alignItems: "center", gap: "6px" }}
            >
              📲 Send WhatsApp Alert to {numbers.length} number{numbers.length > 1 ? "s" : ""}
            </button>
          )}
        </div>
      )}
      {lowStock.length === 0 && <div style={{ color: "#22c55e", fontSize: "12px" }}>✅ All products above low stock threshold.</div>}

      <div style={{ display: "grid", gap: "6px" }}>
        <div style={{ fontSize: "12px", color: "#94a3b8", fontWeight: 600 }}>Add WhatsApp Number (with country code):</div>
        <div style={{ display: "flex", gap: "6px" }}>
          <input
            placeholder="e.g. 919876543210"
            value={newNumber}
            onChange={e => setNewNumber(e.target.value)}
            onKeyDown={e => e.key === "Enter" && addNumber()}
            style={{ flex: 1, background: "#fff", border: "1px solid #cbd5e1", borderRadius: "6px", color: "#0f172a", padding: "7px 10px", fontSize: "12px" }}
          />
          <button className="primary-button" style={{ minHeight: "unset", padding: "7px 14px", fontSize: "12px", whiteSpace: "nowrap" }} onClick={addNumber}>Add</button>
        </div>
        <div style={{ fontSize: "11px", color: "#64748b" }}>India: start with 91 (e.g. 919876543210)</div>
      </div>

      {numbers.length === 0
        ? <div style={{ color: "#64748b", fontSize: "12px" }}>No numbers saved. Add a WhatsApp number above to enable alerts.</div>
        : <div style={{ display: "grid", gap: "4px" }}>
            {numbers.map(phone => (
              <div key={phone} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#0f172a", border: "1px solid #26364d", borderRadius: "6px", padding: "6px 10px" }}>
                <span style={{ color: "#e2e8f0", fontSize: "12px" }}>+{phone}</span>
                <button style={sBtn} onClick={() => saveNumbers(numbers.filter(n => n !== phone))}>✕</button>
              </div>
            ))}
          </div>
      }

      <div style={{ fontSize: "11px", color: "#475569", background: "#0f172a", borderRadius: "6px", padding: "8px 10px", lineHeight: "1.7" }}>
        💡 <strong style={{ color: "#94a3b8" }}>How it works:</strong> When low stock is detected, click the green button above. WhatsApp will open for each saved number with the alert message already typed — just press <strong style={{ color: "#22c55e" }}>Send</strong>!
      </div>
    </div>
  );
}

// FIX 1: Removed orphaned try/catch block that was floating at module level before StaffAdmin.
function StaffAdmin({ setMessage }) {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ username: "", password: "", role: "staff" });

  async function loadUsers() {
    try {
      const response = await api.get("/users");
      setUsers(response?.data || []);
    } catch (error) {
      console.error("[StaffAdmin] Failed to load users:", error);
      setUsers([]);
    }
  }

  useEffect(() => {
    loadUsers();
  }, []);

  async function createUser(event) {
    event.preventDefault();
    await api.post("/users", form);
    setForm({ username: "", password: "", role: "staff" });
    setMessage("Staff user created.");
    await loadUsers();
  }

  async function updateUser(user, changes) {
    await api.patch(`/users/${user.id}`, changes);
    await loadUsers();
  }

  return (
    <section className="admin-layout">
      <form className="content-panel form-grid" onSubmit={createUser}>
        <input placeholder="Username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
        <input type="password" placeholder="Password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
          <option value="staff">Staff</option>
          <option value="admin">Admin</option>
        </select>
        <button className="primary-button">Create User</button>
      </form>
      <DataTable
        columns={["Username", "Role", "Active", "Actions"]}
        rows={users.map((user) => [
          user.username,
          user.role,
          user.active ? "Yes" : "No",
          <span className="row-actions" key={user.id}>
            <button onClick={() => updateUser(user, { role: user.role === "admin" ? "staff" : "admin" })}>
              {user.role === "admin" ? "Make Staff" : "Make Admin"}
            </button>
            <button onClick={() => updateUser(user, { active: user.active ? 0 : 1 })}>
              {user.active ? "Disable" : "Enable"}
            </button>
          </span>
        ])}
      />
    </section>
  );
}

// FIX 2: Removed the extra closing brace `}` that appeared after WhatsAppAlerts / before CategoriesAdmin.
function CategoriesAdmin({ reload, setMessage, isAdmin }) {
  const [categories, setCategories] = useState([]);
  const [selectedParent, setSelectedParent] = useState(null);
  const [parentForm, setParentForm] = useState({ name: "" });
  const [childForm, setChildForm] = useState({ name: "" });
  const [movingId, setMovingId] = useState(null);

  async function loadCategories() {
    try {
      const response = await api.get("/categories");
      const data = response?.data || [];
      setCategories(data);
      if (selectedParent) {
        const updated = data.find(c => c.id === selectedParent.id);
        setSelectedParent(updated || null);
      }
    } catch (error) {
      console.error("[CategoryAdmin] Failed to load categories:", error);
      setCategories([]);
    }
  }

  useEffect(() => { loadCategories(); }, []);

  const parents = categories.filter(c => !c.parent_id);
  const children = selectedParent ? categories.filter(c => c.parent_id === selectedParent.id) : [];

  async function addParent(e) {
    e.preventDefault();
    if (!parentForm.name.trim()) return;
    try {
      await api.post("/categories", { name: parentForm.name.trim() });
      setParentForm({ name: "" });
      setMessage("Parent category added.");
      await loadCategories();
      await reload();
    } catch (error) {
      console.error("[CategoryAdmin] Failed to add parent:", error);
      setMessage({ type: "error", text: "Failed to add category" });
    }
  }

  async function addChild(e) {
    e.preventDefault();
    if (!childForm.name.trim() || !selectedParent) return;
    try {
      await api.post("/categories", { name: childForm.name.trim(), parent_id: selectedParent.id });
      setChildForm({ name: "" });
      setMessage("Sub-category added.");
      await loadCategories();
      await reload();
    } catch (error) {
      console.error("[CategoryAdmin] Failed to add child:", error);
      setMessage({ type: "error", text: "Failed to add sub-category" });
    }
  }

  async function moveToParent(catId, newParentId) {
    try {
      await api.patch(`/categories/${catId}`, { parent_id: newParentId || null });
      setMovingId(null);
      setMessage("Category moved.");
      await loadCategories();
      await reload();
    } catch (error) {
      console.error("[CategoryAdmin] Failed to move category:", error);
      setMessage({ type: "error", text: "Failed to move category" });
    }
  }

  async function removeCategory(id, hasChildren) {
    const msg = hasChildren ? "This category has sub-categories. Delete them first, or move them." : "Delete this category?";
    if (!confirm(msg)) return;
    try {
      await api.delete(`/categories/${id}`);
      setMessage("Category deleted.");
      await loadCategories();
      await reload();
    } catch (error) {
      console.error("[CategoryAdmin] Failed to delete category:", error);
      setMessage({ type: "error", text: "Failed to delete category" });
    }
  }

  return (
    <section className="admin-layout">
      <div className="content-panel" style={{flex:"0 0 35%"}}>
        <h3>Categories</h3>
        <form className="cat-add-form" onSubmit={addParent}>
          <input
            placeholder="New parent name"
            value={parentForm.name}
            onChange={e => setParentForm({ name: e.target.value })}
          />
          <button className="primary-button">Add</button>
        </form>
        <div className="cat-list">
          {parents.map(p => {
            const hasKids = categories.some(c => c.parent_id === p.id);
            return (
              <div
                key={p.id}
                className={`cat-item${selectedParent?.id === p.id ? " cat-item-active" : ""}`}
                onClick={() => { setSelectedParent(p); setMovingId(null); }}
              >
                <span className="cat-item-name">
                  {p.name}
                  {hasKids && <span className="cat-child-count"> ({categories.filter(c => c.parent_id === p.id).length})</span>}
                </span>
                {p.name !== "General" && isAdmin && (
                  <span style={{display:"flex",gap:"4px"}}>
                    <button
                      className="cat-delete-btn"
                      style={{color:"#38bdf8",opacity:0.7}}
                      onClick={ev => { ev.stopPropagation(); setMovingId(movingId === p.id ? null : p.id); }}
                      title="Move under a parent"
                    >⇢</button>
                    <button
                      className="cat-delete-btn"
                      onClick={ev => { ev.stopPropagation(); removeCategory(p.id, hasKids); }}
                      title="Delete"
                    ><Trash2 size={14} /></button>
                  </span>
                )}
                {movingId === p.id && (
                  <div className="cat-move-dropdown" onClick={ev => ev.stopPropagation()}>
                    <span style={{fontSize:"12px",color:"#94a3b8"}}>Move "{p.name}" under:</span>
                    {parents.filter(pp => pp.id !== p.id).map(pp => (
                      <button key={pp.id} className="cat-move-option" onClick={() => moveToParent(p.id, pp.id)}>
                        {pp.name}
                      </button>
                    ))}
                    <button className="cat-move-option" style={{color:"#94a3b8"}} onClick={() => moveToParent(p.id, null)}>
                      Keep as top-level
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="content-panel" style={{flex:"1"}}>
        <h3>Sub-Categories</h3>
        {selectedParent ? (
          <>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:"12px"}}>
              <strong>Sub-categories of <span style={{color:"#86efac"}}>{selectedParent.name}</span></strong>
            </div>
            <form className="cat-add-form" onSubmit={addChild}>
              <input
                placeholder={`New sub-category under ${selectedParent.name}`}
                value={childForm.name}
                onChange={e => setChildForm({ name: e.target.value })}
              />
              <button className="primary-button">Add</button>
            </form>
            <div className="cat-list">
              {children.length === 0 ? (
                <div className="cat-empty">No sub-categories yet. Products can be assigned directly to <em>{selectedParent.name}</em>.</div>
              ) : (
                children.map(c => (
                  <div key={c.id} className="cat-item">
                    <span className="cat-item-name">{c.name}</span>
                    {isAdmin && (
                      <button
                        className="cat-delete-btn"
                        onClick={() => removeCategory(c.id, false)}
                        title="Delete"
                      ><Trash2 size={14} /></button>
                    )}
                  </div>
                ))
              )}
            </div>
          </>
        ) : (
          <div className="cat-empty" style={{padding:"40px"}}>
            ← Select a parent category to manage its sub-categories.
          </div>
        )}
      </div>
    </section>
  );
}

// FIX 3: Removed the stray `}` inside Customers that was closing the component
// prematurely, leaving handleReprint/handleViewPng outside the function body.
function Customers({ onReprint, onViewPng, paper }) {
  const [customers, setCustomers] = useState([]);
  const [search, setSearch] = useState("");
  const [history, setHistory] = useState([]);
  const [historySearch, setHistorySearch] = useState("");
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [reprinting, setReprinting] = useState(null);
  const [viewingPng, setViewingPng] = useState(null);

  async function loadCustomers() {
    try {
      const response = await api.get("/customers", { params: { search } });
      setCustomers(response?.data || []);
    } catch (error) {
      console.error("[POS] Failed to load customers:", error);
      setCustomers([]);
    }
  }

  useEffect(() => { loadCustomers(); }, []);

  async function openHistory(customer) {
    try {
      if (!customer.phone || customer.phone === "-") {
        setHistory([]);
        setSelectedCustomer(null);
        return;
      }
      setSelectedCustomer(customer);
      setHistorySearch("");
      const response = await api.get(`/customers/${encodeURIComponent(customer.phone)}/history`);
      setHistory(response?.data || []);
    } catch (error) {
      console.error("[POS] Failed to load customer history:", error);
      setHistory([]);
    }
  }

  async function handleReprint(saleId) {
    setReprinting(saleId);
    try {
      await onReprint(saleId);
    } finally {
      setReprinting(null);
    }
  }

  async function handleViewPng(saleId) {
    setViewingPng(saleId);
    try {
      await onViewPng(saleId);
    } finally {
      setViewingPng(null);
    }
  }

  function formatDateTime(iso) {
    if (!iso) return "-";
    return new Date(iso).toLocaleString("en-IN", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: true
    });
  }

  return (
    <section className="split-layout">
      <div className="content-panel stacked">
        <div className="search-box">
          <Search size={18} />
          <input value={search} placeholder="Search customer or phone" onChange={(e) => setSearch(e.target.value)} />
          <button onClick={loadCustomers}>Search</button>
        </div>
        <DataTable
          columns={["Customer", "Phone", "Visits", "Spend", "Last Visit"]}
          rows={customers.map((c) => [
            <button className="link-button" onClick={() => openHistory(c)} key={c.phone}>{c.customer}</button>,
            c.phone,
            c.visits,
            currency.format(c.spend),
            formatDateTime(c.last_visit)
          ])}
        />
      </div>

      <div className="content-panel stacked">
        <h2 style={{margin:"0 0 12px",fontSize:"15px",color:"#e2e8f0"}}>
          {selectedCustomer
            ? <>Purchase History — <span style={{color:"#86efac"}}>{selectedCustomer.customer}</span> ({selectedCustomer.phone})</>
            : "Purchase History (1 Year)"}
        </h2>
        {selectedCustomer && (
          <div className="search-box" style={{marginBottom:"12px",padding:"0 8px",minHeight:"36px"}}>
            <Search size={14} />
            <input
              style={{fontSize:"13px",minHeight:"32px"}}
              value={historySearch}
              placeholder="Search invoice # or date..."
              onChange={(e) => setHistorySearch(e.target.value)}
            />
          </div>
        )}
        {history.length === 0
          ? <p className="muted">Select a customer with a phone number to view their purchases.</p>
          : history
            .filter(sale => {
              if (!historySearch) return true;
              const q = historySearch.toLowerCase();
              const billNum = (sale.bill_number || sale.id).toString().toLowerCase();
              const dateStr = formatDateTime(sale.created_at).toLowerCase();
              return billNum.includes(q) || dateStr.includes(q);
            })
            .map((sale) => (
            <div className="history-card" key={sale.id}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:"6px"}}>
                <div>
                  <strong style={{color:"#e2e8f0",fontSize:"14px"}}>
                    Invoice #{sale.bill_number || sale.id}
                  </strong>
                  <span style={{marginLeft:"10px",color:"#22c55e",fontWeight:700}}>
                    {currency.format(sale.total)}
                  </span>
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:"4px",alignItems:"flex-end"}}>
                  <button
                    className="primary-button"
                    style={{padding:"4px 12px",fontSize:"12px",minHeight:"unset",display:"flex",gap:"5px",alignItems:"center"}}
                    onClick={() => handleReprint(sale.id)}
                    disabled={reprinting === sale.id}
                  >
                    <Printer size={13} />
                    {reprinting === sale.id ? "Loading…" : "Reprint"}
                  </button>
                  <button
                    className="secondary-button"
                    style={{padding:"4px 12px",fontSize:"12px",minHeight:"unset",display:"flex",gap:"5px",alignItems:"center"}}
                    onClick={() => handleViewPng(sale.id)}
                    disabled={viewingPng === sale.id}
                  >
                    <Image size={13} />
                    {viewingPng === sale.id ? "Loading…" : "View as PNG"}
                  </button>
                </div>
              </div>
              <span style={{color:"#64748b",fontSize:"12px"}}>{formatDateTime(sale.created_at)} · {sale.payment_method}</span>
              <div style={{marginTop:"6px",display:"flex",flexWrap:"wrap",gap:"4px"}}>
                {sale.items.map((item) => (
                  <span key={`${sale.id}-${item.name}`} style={{
                    background:"#1e293b",border:"1px solid #334155",borderRadius:"4px",
                    padding:"2px 8px",fontSize:"11px",color:"#94a3b8"
                  }}>
                    {item.name} × {item.qty}
                  </span>
                ))}
              </div>
            </div>
          ))
        }
      </div>
    </section>
  );
}

function Reports({ setMessage }) {
  const currency = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" });
  const today = new Date().toISOString().slice(0, 10);
  const defaultFrom = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const [range, setRange] = useState({ from: defaultFrom, to: today });
  const [report, setReport] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [loadingTx, setLoadingTx] = useState(false);

  async function loadReport() {
    try {
      setLoadingTx(true);
      const [reportRes, txRes] = await Promise.all([
        api.get("/reports/daily", { params: range }).catch(err => {
          console.error("[API] Daily report error:", err);
          return { data: [] };
        }),
        api.get("/reports/transactions", { params: range }).catch(err => {
          console.error("[API] Transactions report error:", err);
          return { data: [] };
        })
      ]);

      const reportData = reportRes?.data || [];
      const transactionData = txRes?.data || [];

      setReport({
        summary: {
          orders: transactionData.length,
          revenue: transactionData.reduce((sum, s) => sum + (s.total || 0), 0),
          expenses: 0,
          net: transactionData.reduce((sum, s) => sum + (s.total || 0), 0)
        },
        daily: Array.isArray(reportData) ? reportData : [],
        products: Array.isArray(reportData) ? reportData : []
      });
      setTransactions(Array.isArray(transactionData) ? transactionData : []);
    } catch (error) {
      console.error("[POS] Failed to load report:", error);
      setReport(null);
      setTransactions([]);
    } finally {
      setLoadingTx(false);
    }
  }

  async function download(format) {
    try {
      const response = await api.get(`/exports/${format}`, { params: range, responseType: "blob" });
      const blob = response?.data;
      if (!blob) {
        console.error("[Reports] Export failed");
        setMessage && setMessage({ type: "error", text: "Export failed" });
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `pos-report-${range.from}-to-${range.to}.${format}`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error("[Reports] Download error:", error);
      setMessage && setMessage({ type: "error", text: `Failed to download ${format}` });
    }
  }

  function fmtDT(iso) {
    if (!iso) return "-";
    return new Date(iso).toLocaleString("en-IN", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: true
    });
  }

  useEffect(() => { loadReport(); }, []);

  return (
    <section className="stacked">
      <div className="content-panel report-controls">
        <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
        <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
        <button className="primary-button" onClick={loadReport}>Run Report</button>
        <button className="secondary-button" onClick={() => download("xlsx")}><FileSpreadsheet size={18} /> Excel</button>
        <button className="secondary-button" onClick={() => download("pdf")}><Download size={18} /> PDF</button>
      </div>

      {report ? (
        <>
          <section className="dashboard-grid">
            <Metric label="Orders" value={report.summary?.orders || 0} />
            <Metric label="Revenue" value={currency.format(report.summary?.revenue || 0)} />
            <Metric label="Expenses" value={currency.format(report.summary?.expenses || 0)} />
            <Metric label="Net" value={currency.format(report.summary?.net || 0)} />
          </section>

          <div className="content-panel stacked" style={{overflowX:"auto"}}>
            <h3 style={{margin:"0 0 12px",fontSize:"14px",color:"#e2e8f0",fontWeight:600}}>
              Transaction Details {loadingTx && <span style={{color:"#64748b",fontWeight:400,fontSize:"12px"}}>Loading…</span>}
            </h3>
            {transactions.length === 0 ? (
              <p className="muted">No transactions in this period.</p>
            ) : (
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:"12px"}}>
                <thead>
                  <tr style={{background:"#1e293b",color:"#94a3b8",textAlign:"left"}}>
                    <th style={{padding:"8px 10px",borderBottom:"1px solid #334155"}}>Invoice #</th>
                    <th style={{padding:"8px 10px",borderBottom:"1px solid #334155"}}>Date & Time</th>
                    <th style={{padding:"8px 10px",borderBottom:"1px solid #334155"}}>Customer</th>
                    <th style={{padding:"8px 10px",borderBottom:"1px solid #334155"}}>Phone</th>
                    <th style={{padding:"8px 10px",borderBottom:"1px solid #334155"}}>Subtotal</th>
                    <th style={{padding:"8px 10px",borderBottom:"1px solid #334155",textAlign:"right"}}>Tax</th>
                    <th style={{padding:"8px 10px",borderBottom:"1px solid #334155",textAlign:"right"}}>Total</th>
                    <th style={{padding:"8px 10px",borderBottom:"1px solid #334155"}}>Payment</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((sale, i) => (
                    <tr key={sale.id} style={{background: i%2===0 ? "#0f172a" : "#111827", borderBottom:"1px solid #1e293b"}}>
                      <td style={{padding:"8px 10px",color:"#86efac",fontWeight:700}}>#{sale.id}</td>
                      <td style={{padding:"8px 10px",color:"#cbd5e1",whiteSpace:"nowrap"}}>{fmtDT(sale.created_at)}</td>
                      <td style={{padding:"8px 10px",color:"#e2e8f0"}}>{sale.customer_name || <span style={{color:"#475569"}}>Walk-in</span>}</td>
                      <td style={{padding:"8px 10px",color:"#94a3b8"}}>{sale.customer_phone || "-"}</td>
                      <td style={{padding:"8px 10px",color:"#cbd5e1"}}>{currency.format(sale.subtotal || 0)}</td>
                      <td style={{padding:"8px 10px",textAlign:"right",color:"#64748b"}}>{currency.format(sale.tax || 0)}</td>
                      <td style={{padding:"8px 10px",textAlign:"right",color:"#22c55e",fontWeight:700}}>{currency.format(sale.total || 0)}</td>
                      <td style={{padding:"8px 10px",textTransform:"capitalize",color:"#94a3b8"}}>{sale.payment_method || "cash"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}

function Expenses({ setMessage, isAdmin }) {
  const [range, setRange] = useState({ from: defaultFrom, to: today });
  const [expenses, setExpenses] = useState([]);
  const [form, setForm] = useState({ description: "", category: "General", amount: "", expense_date: today });

  async function loadExpenses() {
    try {
      const response = await api.get("/expenses", { params: range });
      setExpenses(response?.data || []);
    } catch (error) {
      console.error("[Expenses] Failed to load expenses:", error);
      setExpenses([]);
    }
  }

  useEffect(() => {
    loadExpenses();
  }, []);

  async function saveExpense(event) {
    event.preventDefault();
    if (!form.description || !form.amount) {
      setMessage("Description and amount are required.");
      return;
    }
    try {
      await api.post("/expenses", { ...form, amount: Number(form.amount) });
      setForm({ description: "", category: "General", amount: "", expense_date: today });
      setMessage("Expense saved.");
      await loadExpenses();
    } catch (e) {
      setMessage(e.response?.data?.error || "Failed to save expense.");
    }
  }

  async function removeExpense(id) {
    if (!isAdmin) return;
    if (!confirm("Delete this expense?")) return;
    try {
      await api.delete(`/expenses/${id}`);
      setMessage("Expense deleted.");
      await loadExpenses();
    } catch (e) {
      setMessage("Failed to delete expense.");
    }
  }

  return (
    <section className="admin-layout">
      <form className="content-panel form-grid" onSubmit={saveExpense}>
        <input placeholder="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <input placeholder="Category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
        <input type="number" min="0" placeholder="Amount" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        <input type="date" value={form.expense_date} onChange={(e) => setForm({ ...form, expense_date: e.target.value })} />
        <button className="primary-button">Add Expense</button>
      </form>
      <div className="content-panel report-controls">
        <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
        <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
        <button className="secondary-button" onClick={loadExpenses}>Filter</button>
      </div>
      <DataTable
        columns={["Date", "Category", "Description", "Amount", "Action"]}
        rows={expenses.map((expense) => [
          expense.expense_date,
          expense.category,
          expense.description,
          currency.format(expense.amount),
          isAdmin ? <button key={expense.id} onClick={() => removeExpense(expense.id)} className="delete-btn-table"><Trash2 size={15} /></button> : "—"
        ])}
      />
    </section>
  );
}

function Dashboard() {
  const [dashboardData, setDashboardData] = useState(null);
  const [mode, setMode] = useState("day");
  const [date, setDate] = useState(today);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [range, setRange] = useState({ from: today, to: today });

  useEffect(() => {
    let from, to;
    if (mode === "day") {
      from = date; to = date;
    } else if (mode === "month") {
      from = `${month}-01`;
      const y = parseInt(month.split('-')[0]);
      const m = parseInt(month.split('-')[1]);
      const lastDay = new Date(y, m, 0).toISOString().slice(0, 10);
      to = lastDay;
    } else {
      from = range.from; to = range.to;
    }

    api.get("/dashboard", { params: { from, to } })
      .then(res => setDashboardData(res.data))
      .catch(err => console.error(err));
  }, [mode, date, month, range]);

  function shiftDay(delta) {
    const d = new Date(date);
    d.setDate(d.getDate() + delta);
    setDate(d.toISOString().slice(0, 10));
  }

  function shiftMonth(delta) {
    const y = parseInt(month.split('-')[0]);
    const m = parseInt(month.split('-')[1]);
    const d = new Date(y, m - 1 + delta, 1);
    const tzOffset = d.getTimezoneOffset() * 60000;
    const localISO = new Date(d.getTime() - tzOffset).toISOString().slice(0, 7);
    setMonth(localISO);
  }

  const paymentData = dashboardData ? [
    { name: 'Cash', value: (dashboardData.paymentSplit || {}).cash || 0, color: '#10b981' },
    { name: 'Card', value: (dashboardData.paymentSplit || {}).card || 0, color: '#3b82f6' },
    { name: 'UPI', value: (dashboardData.paymentSplit || {}).upi || 0, color: '#8b5cf6' }
  ].filter(d => d.value > 0) : [];

  return (
    <section className="admin-layout" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div className="content-panel" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button className={mode === 'day' ? 'primary-button' : 'secondary-button'} onClick={() => setMode('day')}>Daily</button>
          <button className={mode === 'month' ? 'primary-button' : 'secondary-button'} onClick={() => setMode('month')}>Monthly</button>
          <button className={mode === 'range' ? 'primary-button' : 'secondary-button'} onClick={() => setMode('range')}>Custom Range</button>
        </div>

        {mode === 'day' && (
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            <button className="secondary-button" onClick={() => shiftDay(-1)}>&larr; Prev Day</button>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} />
            <button className="secondary-button" onClick={() => shiftDay(1)}>Next Day &rarr;</button>
          </div>
        )}

        {mode === 'month' && (
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            <button className="secondary-button" onClick={() => shiftMonth(-1)}>&larr; Prev Month</button>
            <input type="month" value={month} onChange={e => setMonth(e.target.value)} />
            <button className="secondary-button" onClick={() => shiftMonth(1)}>Next Month &rarr;</button>
          </div>
        )}

        {mode === 'range' && (
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            <input type="date" value={range.from} onChange={e => setRange({...range, from: e.target.value})} />
            <span>to</span>
            <input type="date" value={range.to} onChange={e => setRange({...range, to: e.target.value})} />
          </div>
        )}
      </div>

      {!dashboardData ? <div className="content-panel">Loading dashboard...</div> : (
        <>
          <section className="premium-dashboard-grid">
            <div className="premium-metric-card gradient-1">
              <div className="icon-box"><WalletCards /></div>
              <span className="label">Total Revenue</span>
              <span className="value">{currency.format(dashboardData.summary.revenue || 0)}</span>
            </div>
            <div className="premium-metric-card gradient-2">
              <div className="icon-box"><ReceiptText /></div>
              <span className="label">Total Sales</span>
              <span className="value">{dashboardData.summary.orders || 0}</span>
            </div>
            <div className="premium-metric-card gradient-3">
              <div className="icon-box"><Boxes /></div>
              <span className="label">Products Sold</span>
              <span className="value">{dashboardData.summary.total_products || 0}</span>
            </div>
          </section>

          <section className="premium-charts-container">
            <div className="premium-chart-card">
              <h3>Sales & Purchases</h3>
              {mode === 'day' ? (
                <div style={{ color: '#94a3b8', display: 'flex', height: '280px', alignItems: 'center', justifyContent: 'center' }}>
                  Select Monthly or Custom Range to view sales trends.
                </div>
              ) : dashboardData.dailySales && dashboardData.dailySales.length > 0 ? (
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={dashboardData.dailySales}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                    <XAxis dataKey="day" stroke="#94a3b8" axisLine={false} tickLine={false} />
                    <YAxis stroke="#94a3b8" axisLine={false} tickLine={false} tickFormatter={(val) => `₹${val}`} />
                    <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(255,255,255,0.05)' }} />
                    <Bar dataKey="total" fill="url(#colorTotal)" radius={[6, 6, 0, 0]} barSize={40} />
                    <defs>
                      <linearGradient id="colorTotal" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#ec4899" stopOpacity={0.9}/>
                        <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0.9}/>
                      </linearGradient>
                    </defs>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div style={{ color: '#94a3b8', display: 'flex', height: '280px', alignItems: 'center', justifyContent: 'center' }}>
                  No sales data for this period.
                </div>
              )}
            </div>

            <div className="premium-chart-card">
              <h3>Payment Methods</h3>
              {paymentData.length > 0 ? (
                <ResponsiveContainer width="100%" height={280}>
                  <PieChart>
                    <Pie
                      data={paymentData}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={100}
                      paddingAngle={5}
                      dataKey="value"
                      stroke="none"
                    >
                      {paymentData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip content={<CustomTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div style={{ color: '#94a3b8', display: 'flex', height: '280px', alignItems: 'center', justifyContent: 'center' }}>
                  No payments recorded.
                </div>
              )}
              {paymentData.length > 0 && (
                <div style={{ display: 'flex', gap: '16px', justifyContent: 'center', flexWrap: 'wrap', marginTop: '16px' }}>
                  {paymentData.map((entry) => (
                    <div key={entry.name} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: entry.color }} />
                      <span style={{ color: '#94a3b8', fontSize: '13px' }}>{entry.name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </section>
  );
}

function CustomTooltip({ active, payload, label }) {
  if (active && payload && payload.length) {
    return (
      <div className="custom-tooltip">
        <div className="label">{label || payload[0].name}</div>
        <div className="value">{currency.format(payload[0].value)}</div>
      </div>
    );
  }
  return null;
}

function Metric({ label, value }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function CustomToast({ message, onClose }) {
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => {
      onClose();
    }, 4000);
    return () => clearTimeout(timer);
  }, [message]); // eslint-disable-line react-hooks/exhaustive-deps

  return createPortal(
    <div
      className="iphone-toast-wrapper"
      style={{
        opacity: message ? 1 : 0,
        transform: message ? "translateX(-50%) translateY(0)" : "translateX(-50%) translateY(-130%)",
        pointerEvents: "none"
      }}
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="iphone-toast">
        <div className="iphone-toast-icon">
          <Bell size={18} />
        </div>
        <div className="iphone-toast-text">
          <span className="iphone-toast-app">Vedha Mobiles</span>
          <span className="iphone-toast-msg">{message}</span>
        </div>
      </div>
    </div>,
    document.getElementById("toast-root") || document.body
  );
}

function DataTable({ columns, rows }) {
  return (
    <section className="inventory-table">
      <div className="data-head" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}>
        {columns.map((column) => <span key={column}>{column}</span>)}
      </div>
      {rows.map((row, index) => (
        <div className="data-row" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }} key={index}>
          {row.map((cell, cellIndex) => <span key={cellIndex}>{cell}</span>)}
        </div>
      ))}
    </section>
  );
}

function numberToWords(num) {
  const a = ['', 'One ', 'Two ', 'Three ', 'Four ', 'Five ', 'Six ', 'Seven ', 'Eight ', 'Nine ', 'Ten ', 'Eleven ', 'Twelve ', 'Thirteen ', 'Fourteen ', 'Fifteen ', 'Sixteen ', 'Seventeen ', 'Eighteen ', 'Nineteen '];
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  if ((num = Math.floor(num).toString()).length > 9) return 'overflow';
  let n = ('000000000' + num).substr(-9).match(/^(\d{2})(\d{2})(\d{2})(\d{1})(\d{2})$/);
  if (!n) return ''; let str = '';
  str += (n[1] != 0) ? (a[Number(n[1])] || b[n[1][0]] + ' ' + a[n[1][1]]) + 'Crore ' : '';
  str += (n[2] != 0) ? (a[Number(n[2])] || b[n[2][0]] + ' ' + a[n[2][1]]) + 'Lakh ' : '';
  str += (n[3] != 0) ? (a[Number(n[3])] || b[n[3][0]] + ' ' + a[n[3][1]]) + 'Thousand ' : '';
  str += (n[4] != 0) ? (a[Number(n[4])] || b[n[4][0]] + ' ' + a[n[4][1]]) + 'Hundred ' : '';
  str += (n[5] != 0) ? ((str != '') ? 'and ' : '') + (a[Number(n[5])] || b[n[5][0]] + ' ' + a[n[5][1]]) : '';
  return str.trim() ? str.trim() + ' Rupees Only' : 'Zero Rupees Only';
}

function Receipt80mm({ receipt }) {
  const items = receipt.items || [];
  const isTaxFree = receipt.tax === 0;
  const isInclusive = !isTaxFree && receipt.subtotal === receipt.total;
  const dateObj = receipt.date ? new Date(receipt.date) : new Date();
  const isValid = !isNaN(dateObj.getTime());
  const datePart = isValid ? dateObj.toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric" }) : (receipt.date?.split(",")[0] || "");
  const timePart = isValid ? dateObj.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true }).toUpperCase() : (receipt.date?.split(",")[1]?.trim() || "");
  const base = { fontFamily: "Arial, sans-serif", fontSize: "11px", color: "#000", backgroundColor: "#fff", width: "100%", padding: "0 6px 6px 6px", boxSizing: "border-box", display: "block" };
  const hr = <div style={{ borderTop: "1px solid #000", margin: "4px 0" }} />;
  return (
    <section className="receipt-print">
      <div style={base}>
        <img src="./header-80mm.png" alt="Header" style={{ width: "100%", height: "auto", display: "block", marginBottom: "6px" }} />

        <div style={{ marginBottom: "2px", display: "block" }}>
          <div style={{ display: "block" }}><strong>Customer:</strong> {receipt.customer || "Walk-in"}</div>
          {receipt.phone && <div style={{ display: "block" }}><strong>Phone:</strong> {receipt.phone}</div>}
          {receipt.gstNumber && <div style={{ display: "block" }}><strong>GST No:</strong> {receipt.gstNumber}</div>}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "2px" }}>
          <span><strong>Date:</strong> {datePart} {timePart}</span>
          <span><strong>Invoice:</strong> {receipt.billNumber || "-"}</span>
        </div>

        {hr}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 26px 54px 54px", fontWeight: "bold", fontSize: "11px", gap: "2px" }}>
          <span>Description</span>
          <span style={{ textAlign: "center" }}>Qty</span>
          <span style={{ textAlign: "right" }}>Rate</span>
          <span style={{ textAlign: "right" }}>Amount</span>
        </div>

        {hr}

        {items.map((item, idx) => {
          const effectiveRate = Number(item.price) - (item.discount || 0);
          const rate = isInclusive ? effectiveRate / 1.18 : effectiveRate;
          const amt = effectiveRate * item.qty;
          return (
            <div key={idx} style={{ display: "grid", gridTemplateColumns: "1fr 26px 54px 54px", fontSize: "11px", gap: "2px", marginBottom: "2px" }}>
              <span style={{ wordBreak: "break-word" }}>{item.name}</span>
              <span style={{ textAlign: "center" }}>{item.qty}</span>
              <span style={{ textAlign: "right" }}>{rate.toFixed(2)}</span>
              <span style={{ textAlign: "right" }}>{amt.toFixed(2)}</span>
            </div>
          );
        })}

        {hr}

        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", marginBottom: "2px" }}>
          <span>Total</span><span>{Number(receipt.subtotal).toFixed(2)}</span>
        </div>
        {!isTaxFree && <>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", marginBottom: "2px" }}>
            <span>CGST 9%</span><span>{Number(receipt.tax / 2).toFixed(2)}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", marginBottom: "2px" }}>
            <span>SGST 9%</span><span>{Number(receipt.tax / 2).toFixed(2)}</span>
          </div>
        </>}

        {hr}

        <div style={{ display: "flex", justifyContent: "space-between", fontWeight: "bold", fontSize: "13px", marginBottom: "4px" }}>
          <span>Net Amount</span>
          <span>{Number(receipt.total).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
        </div>

        {hr}

        <div style={{ fontSize: "9px", color: "#333", display: "block" }}>{numberToWords(receipt.total)}</div>
      </div>
    </section>
  );
}

function Receipt({ receipt, paper }) {
  if (paper === "80mm") return <Receipt80mm receipt={receipt} />;
  const isTaxFree = receipt.tax === 0;
  const isInclusive = !isTaxFree && receipt.subtotal === receipt.total;
  const isExclusive = !isTaxFree && !isInclusive;

  let headerSrc = "./header-a4.png";
  if (paper === "A5") headerSrc = "./header-a5.png";

  return (
    <section className="receipt-print">
      <div className="professional-invoice-container" style={{fontFamily: "Arial, sans-serif", display: "flex", flexDirection: "column", color: "#000", backgroundColor: "#fff"}}>
         <img src={headerSrc} alt={`${paper} Header`} style={{width: "100%", height: "auto", marginBottom: "10px", display: "block"}} />
         <div className="invoice-title" style={{textAlign: "center", textDecoration: "underline", fontWeight: "bold", margin: "5px 0 15px 0", fontSize: "16px", display: "block"}}>TAX INVOICE</div>

         <table className="info-table-top" style={{width: "100%", marginBottom: "15px", borderCollapse: "collapse", border: "2px solid #000"}}>
            <tbody>
              <tr>
                <td style={{width: "50%", border: "1px solid #000", padding: "6px"}}><strong>INVOICE NO:</strong> {receipt.billNumber}</td>
                <td style={{width: "50%", border: "1px solid #000", padding: "6px"}}><strong>PLACE OF SUPPLY:</strong> Tamil Nadu</td>
              </tr>
              <tr>
                <td style={{border: "1px solid #000", padding: "6px"}}><strong>INVOICE DATE:</strong> {receipt.date?.split(',')[0]}</td>
                <td style={{border: "1px solid #000", padding: "6px"}}><strong>Date &amp; Time of supply:</strong> {receipt.date}</td>
              </tr>
            </tbody>
         </table>

         <table className="info-table-address" style={{width: "100%", marginBottom: "15px", textAlign: "left", borderCollapse: "collapse", border: "2px solid #000"}}>
            <thead>
              <tr>
                <th colSpan="2" style={{border: "1px solid #000", padding: "6px", textDecoration: "underline", textAlign: "center", width: "50%"}}>Detail of Receiver (Billing Address)</th>
                <th colSpan="2" style={{border: "1px solid #000", padding: "6px", textDecoration: "underline", textAlign: "center", width: "50%"}}>Detail of consignee (Shipping Address)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{width: "15%", fontWeight: "bold", border: "1px solid #000", padding: "6px"}}>Name:</td>
                <td style={{width: "35%", border: "1px solid #000", padding: "6px"}}>{receipt.customer}</td>
                <td style={{width: "15%", fontWeight: "bold", border: "1px solid #000", padding: "6px"}}>Name:</td>
                <td style={{width: "35%", border: "1px solid #000", padding: "6px"}}>{receipt.customer}</td>
              </tr>
              <tr>
                <td style={{fontWeight: "bold", border: "1px solid #000", padding: "6px"}}>Address:</td>
                <td style={{border: "1px solid #000", padding: "6px"}}>{receipt.address}</td>
                <td style={{fontWeight: "bold", border: "1px solid #000", padding: "6px"}}>Address:</td>
                <td style={{border: "1px solid #000", padding: "6px"}}>{receipt.address}</td>
              </tr>
              <tr>
                <td style={{fontWeight: "bold", border: "1px solid #000", padding: "6px"}}>Phone no:</td>
                <td style={{border: "1px solid #000", padding: "6px"}}>{receipt.phone}</td>
                <td style={{fontWeight: "bold", border: "1px solid #000", padding: "6px"}}>Phone No:</td>
                <td style={{border: "1px solid #000", padding: "6px"}}>{receipt.phone}</td>
              </tr>
              <tr>
                <td style={{fontWeight: "bold", border: "1px solid #000", padding: "6px"}}>GST No:</td>
                <td style={{border: "1px solid #000", padding: "6px"}}>{receipt.gstNumber}</td>
                <td style={{fontWeight: "bold", border: "1px solid #000", padding: "6px"}}>GST No:</td>
                <td style={{border: "1px solid #000", padding: "6px"}}>{receipt.gstNumber}</td>
              </tr>
              <tr>
                <td style={{fontWeight: "bold", border: "1px solid #000", padding: "6px"}}>State:</td>
                <td style={{border: "1px solid #000", padding: "6px"}}>Tamil Nadu</td>
                <td style={{fontWeight: "bold", border: "1px solid #000", padding: "6px"}}>State:</td>
                <td style={{border: "1px solid #000", padding: "6px"}}>Tamil Nadu</td>
              </tr>
            </tbody>
         </table>

         <table className="main-invoice-table" style={{width: "100%", textAlign: "center", borderCollapse: "collapse", border: "2px solid #000"}}>
           <thead style={{height: "1px"}}>
             <tr>
               <th style={{border: "1px solid #000", borderBottom: "2px solid #000", padding: "8px", width: "36%"}}>Name of the products</th>
               <th style={{border: "1px solid #000", borderBottom: "2px solid #000", padding: "8px", width: "12%"}}>CGST</th>
               <th style={{border: "1px solid #000", borderBottom: "2px solid #000", padding: "8px", width: "12%"}}>SGST</th>
               <th style={{border: "1px solid #000", borderBottom: "2px solid #000", padding: "8px", width: "10%"}}>Qty</th>
               <th style={{border: "1px solid #000", borderBottom: "2px solid #000", padding: "8px", width: "15%"}}>RATE</th>
               <th style={{border: "1px solid #000", borderBottom: "2px solid #000", padding: "8px", width: "15%"}}>AMOUNT</th>
             </tr>
           </thead>
           <tbody>
               {receipt.items.map((item, idx) => {
                 const discount = item.discount || 0;
                 const effectiveRate = item.price - discount;
                 const amount = effectiveRate * item.qty;
                 const cgstRate = (item.cgst ?? 9) / 100;
                 const sgstRate = (item.sgst ?? 9) / 100;
                 let cgst = 0, sgst = 0, rate = effectiveRate;
                 if (isExclusive) { cgst = amount * cgstRate; sgst = amount * sgstRate; }
                 else if (isInclusive) {
                   const totalRate = 1 + cgstRate + sgstRate;
                   const baseAmount = amount / totalRate;
                   cgst = baseAmount * cgstRate;
                   sgst = baseAmount * sgstRate;
                   rate = effectiveRate / totalRate;
                 }
                 return (
                   <tr key={item.product_id + "-" + idx}>
                     <td style={{padding: "8px", textAlign: "left", border: "1px solid #000", width: "36%", verticalAlign: "top"}}>
                       <div>{item.name}</div>
                       {item.description && <div style={{fontSize:"11px", color:"#555", marginTop:"3px", fontStyle:"italic"}}>{item.description}</div>}
                     </td>
                     <td style={{padding: "8px", border: "1px solid #000", textAlign: "center", width: "12%", verticalAlign: "top"}}>{cgst > 0 ? currency.format(cgst) : ""}</td>
                     <td style={{padding: "8px", border: "1px solid #000", textAlign: "center", width: "12%", verticalAlign: "top"}}>{sgst > 0 ? currency.format(sgst) : ""}</td>
                     <td style={{padding: "8px", border: "1px solid #000", textAlign: "center", width: "10%", verticalAlign: "top"}}>{item.qty}</td>
                     <td style={{padding: "8px", border: "1px solid #000", textAlign: "center", width: "15%", verticalAlign: "top"}}>{currency.format(rate)}</td>
                     <td style={{padding: "8px", border: "1px solid #000", textAlign: "center", width: "15%", verticalAlign: "top"}}>{currency.format(amount)}</td>
                   </tr>
                 );
              })}
               <tr className="filler-row">
                 <td style={{border: "1px solid #000", borderBottom: "2px solid #000", width: "36%"}}></td>
                 <td style={{border: "1px solid #000", borderBottom: "2px solid #000", width: "12%"}}></td>
                 <td style={{border: "1px solid #000", borderBottom: "2px solid #000", width: "12%"}}></td>
                 <td style={{border: "1px solid #000", borderBottom: "2px solid #000", width: "10%"}}></td>
                 <td style={{border: "1px solid #000", borderBottom: "2px solid #000", width: "15%"}}></td>
                 <td style={{border: "1px solid #000", borderBottom: "2px solid #000", width: "15%"}}></td>
               </tr>
           </tbody>
           <tfoot style={{height: "1px"}}>
              <tr>
                <td colSpan="4" rowSpan="3" style={{border: "1px solid #000", borderLeft: "none", borderBottom: "none", textAlign: "left", padding: "10px", verticalAlign: "top", width: "70%"}}>
                   <div className="words-title" style={{fontWeight: "bold", marginBottom: "5px"}}>TOTAL IN WORDS:</div>
                   <div className="words-amount" style={{textTransform: "uppercase"}}>{numberToWords(receipt.total)}</div>
                </td>
                <td style={{border: "1px solid #000", padding: "8px", fontWeight: "bold", textAlign: "center", width: "15%"}}>TOTAL</td>
                <td style={{border: "1px solid #000", borderRight: "none", padding: "8px", fontWeight: "bold", textAlign: "center", width: "15%"}}>{currency.format(receipt.subtotal)}</td>
              </tr>
              <tr>
                <td style={{border: "1px solid #000", padding: "8px", fontWeight: "bold", textAlign: "center"}}>CGST</td>
                <td style={{border: "1px solid #000", borderRight: "none", padding: "8px", fontWeight: "bold", textAlign: "center"}}>{currency.format(receipt.tax / 2)}</td>
              </tr>
              <tr>
                <td style={{border: "1px solid #000", padding: "8px", fontWeight: "bold", textAlign: "center"}}>SGST</td>
                <td style={{border: "1px solid #000", borderRight: "none", padding: "8px", fontWeight: "bold", textAlign: "center"}}>{currency.format(receipt.tax / 2)}</td>
              </tr>
              <tr>
                <td colSpan="4" style={{border: "1px solid #000", padding: "15px", fontWeight: "bold", textAlign: "left", verticalAlign: "top"}}>
                    <div style={{fontSize: "11px", textAlign: "left", display: "flex", flexDirection: "column", gap: "2px"}}>
                      <div style={{display: "block"}}>• All products comes under one year warranty</div>
                      <div style={{display: "block"}}>• Warranty will be void for any physical and liquid/water damages</div>
                      <div style={{display: "block"}}>• Boxes and accessories are mandatory</div>
                    </div>
                </td>
                <td style={{border: "1px solid #000", padding: "8px", fontWeight: "bold", verticalAlign: "middle", textAlign: "center"}}>Net Amount</td>
                <td className="net-amount-val" style={{border: "1px solid #000", borderRight: "none", padding: "8px", fontWeight: "bold", verticalAlign: "middle", textAlign: "center", backgroundColor: "#f8fafc"}}>{currency.format(receipt.total)}</td>
              </tr>
              <tr>
                <td colSpan="6" className="signatory-box" style={{border: "1px solid #000", borderRight: "none", borderBottom: "none", padding: "15px", fontWeight: "bold", textAlign: "right"}}>
                   <div style={{display: "flex", flexDirection: "column", justifyContent: "space-between", minHeight: "100px", alignItems: "flex-end"}}>
                     <div>For VEDHA MOBILES</div>
                     <div style={{marginTop: "50px"}}>Authorized Signatory</div>
                   </div>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
    </section>
  );
}