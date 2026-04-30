import { supabase, login as supabaseLogin } from "./supabase.js";

// Wrapper API object to replace Axios calls with Supabase
const api = {
  // Auth endpoint
  post: async (endpoint, data) => {
    try {
      if (endpoint === "/login") {
        const { username, password } = data;
        
        const result = await supabaseLogin(username, password);
        
        if (!result.success) {
          throw { response: { data: { error: result.error } } };
        }

        return {
          data: {
            success: true,
            token: result.token,
            user: result.user
          }
        };
      }

      // POST /notify/lowstock
      if (endpoint === "/notify/lowstock") {
        return { data: { sent: 0 } };
      }

      // POST /sales
      // FIX 1: POS.jsx sends { customer, phone, items, payment_method, tax_mode }
      // The old code destructured customer_name/customer_phone which don't exist in the payload.
      // Also fixed item field names: qty/price instead of quantity/unit_price,
      // and stock is decremented rather than a pre-computed remaining_stock.
      if (endpoint === "/sales") {
        const { customer, phone, address, gstNumber, items, payment_method, tax_mode } = data;

        // Compute totals from items based on tax_mode
        let subtotal = 0;
        let tax = 0;

        for (const item of items) {
          const effectivePrice = item.price - (item.discount || 0);
          const lineTotal = effectivePrice * item.qty;
          subtotal += lineTotal;
          if (tax_mode === "exclusive") {
            const cgst = lineTotal * ((item.cgst ?? 9) / 100);
            const sgst = lineTotal * ((item.sgst ?? 9) / 100);
            tax += cgst + sgst;
          } else if (tax_mode === "inclusive") {
            // tax is already inside the price, extract it
            const cgstRate = (item.cgst ?? 9) / 100;
            const sgstRate = (item.sgst ?? 9) / 100;
            const totalRate = 1 + cgstRate + sgstRate;
            const base = lineTotal / totalRate;
            tax += lineTotal - base;
          }
        }

        subtotal = Number(subtotal.toFixed(2));
        tax = Number(tax.toFixed(2));
        const total = Number((subtotal + tax).toFixed(2));

        const { data: sale, error: saleError } = await supabase
          .from("sales")
          .insert({
            customer: customer || "Walk-in",
            phone: phone || null,
            address: address || null,
            gst_number: gstNumber || null,
            subtotal,
            tax,
            total,
            payment_method: payment_method || "cash"
          })
          .select()
          .maybeSingle();

        if (saleError) throw saleError;
        if (!sale) throw new Error("Failed to create sale");

        // Insert sale items using correct field names (qty, price, discount)
        if (items && items.length > 0) {
          const saleItems = items.map(item => ({
            sale_id: sale.id,
            product_id: item.product_id,
            name: item.name,
            qty: item.qty,
            price: item.price,
            discount: item.discount || 0,
            description: item.description || "",
            cgst: item.cgst ?? 9,
            sgst: item.sgst ?? 9,
            line_total: Number(((item.price - (item.discount || 0)) * item.qty).toFixed(2))
          }));

          const { error: itemsError } = await supabase
            .from("sale_items")
            .insert(saleItems);

          if (itemsError) throw itemsError;

          // Decrement stock for each product
          for (const item of items) {
            const { data: product } = await supabase
              .from("products")
              .select("stock")
              .eq("id", item.product_id)
              .maybeSingle();

            if (product) {
              await supabase
                .from("products")
                .update({ stock: Math.max(0, product.stock - item.qty) })
                .eq("id", item.product_id);
            }
          }
        }

        return { data: { sale } };
      }

      // POST /products
      if (endpoint === "/products") {
        const { name, category_id, price, stock, low_stock_threshold, location } = data;
        
        const { data: product, error } = await supabase
          .from("products")
          .insert({
            name,
            category_id,
            price,
            stock,
            low_stock_threshold,
            location,
            active: true
          })
          .select()
          .maybeSingle();

        if (error) throw error;
        return { data: product };
      }

      // POST /users
      if (endpoint === "/users") {
        const { username, password, role } = data;
        
        const { hashPassword } = await import("./supabase.js");
        const password_hash = await hashPassword(password);

        const { data: user, error } = await supabase
          .from("users")
          .insert({
            username,
            password_hash,
            role,
            active: true
          })
          .select()
          .maybeSingle();

        if (error) throw error;
        return { data: user };
      }

      // POST /categories
      if (endpoint === "/categories") {
        const { name, parent_id } = data;
        
        const { data: category, error } = await supabase
          .from("categories")
          .insert({
            name,
            parent_id: parent_id || null
          })
          .select()
          .maybeSingle();

        if (error) throw error;
        return { data: category };
      }

      // POST /expenses
      if (endpoint === "/expenses") {
        const { description, category, amount, expense_date } = data;
        
        const { data: expense, error } = await supabase
          .from("expenses")
          .insert({
            description,
            category: category || "General",
            amount,
            expense_date: expense_date || new Date().toISOString().slice(0, 10)
          })
          .select()
          .maybeSingle();

        if (error) throw error;
        return { data: expense };
      }

      console.warn(`[API] POST endpoint not implemented: ${endpoint}`);
      return { data: null };
    } catch (error) {
      console.error(`[API] POST ${endpoint} error:`, error);
      throw error;
    }
  },

  patch: async (endpoint, data) => {
    try {
      // PATCH /products/:id
      if (endpoint.match(/^\/products\/\d+$/)) {
        const id = endpoint.split("/")[2];
        const { name, category_id, price, stock, low_stock_threshold, location } = data;

        const { data: product, error } = await supabase
          .from("products")
          .update({ name, category_id, price, stock, low_stock_threshold, location })
          .eq("id", id)
          .select()
          .maybeSingle();

        if (error) throw error;
        return { data: product };
      }

      // PATCH /users/:id
      if (endpoint.match(/^\/users\/\d+$/)) {
        const id = endpoint.split("/")[2];

        const { data: user, error } = await supabase
          .from("users")
          .update(data)
          .eq("id", id)
          .select()
          .maybeSingle();

        if (error) throw error;
        return { data: user };
      }

      // PATCH /categories/:id
      if (endpoint.match(/^\/categories\/\d+$/)) {
        const id = endpoint.split("/")[2];

        const { data: category, error } = await supabase
          .from("categories")
          .update(data)
          .eq("id", id)
          .select()
          .maybeSingle();

        if (error) throw error;
        return { data: category };
      }

      console.warn(`[API] PATCH endpoint not implemented: ${endpoint}`);
      return { data: null };
    } catch (error) {
      console.error(`[API] PATCH ${endpoint} error:`, error);
      throw error;
    }
  },

  delete: async (endpoint) => {
    try {
      // DELETE /products/:id
      if (endpoint.match(/^\/products\/\d+$/)) {
        const id = endpoint.split("/")[2];
        const { error } = await supabase
          .from("products")
          .update({ active: false })
          .eq("id", id);
        if (error) throw error;
        return { data: null };
      }

      // DELETE /categories/:id
      if (endpoint.match(/^\/categories\/\d+$/)) {
        const id = endpoint.split("/")[2];
        const { error } = await supabase
          .from("categories")
          .delete()
          .eq("id", id);
        if (error) throw error;
        return { data: null };
      }

      // DELETE /expenses/:id
      if (endpoint.match(/^\/expenses\/\d+$/)) {
        const id = endpoint.split("/")[2];
        const { error } = await supabase
          .from("expenses")
          .delete()
          .eq("id", id);
        if (error) throw error;
        return { data: null };
      }

      console.warn(`[API] DELETE endpoint not implemented: ${endpoint}`);
      return { data: null };
    } catch (error) {
      console.error(`[API] DELETE ${endpoint} error:`, error);
      throw error;
    }
  },

  // GET endpoints
  get: async (endpoint, options = {}) => {
    const params = options.params || {};
    const session = JSON.parse(sessionStorage.getItem("pos-session") || "{}");
    const user = session.user;

    try {
      // GET /products
      if (endpoint === "/products") {
        let query = supabase
          .from("products")
          .select(`
            id,
            name,
            category_id,
            price,
            stock,
            low_stock_threshold,
            location,
            active,
            categories(name)
          `)
          .order("name");

        if (!params.includeInactive || !user || user.role !== "admin") {
          query = query.eq("active", true);
        }

        const { data, error } = await query;
        if (error) throw error;
        
        return {
          data: data.map(p => ({
            ...p,
            category_name: p.categories?.name || "General"
          }))
        };
      }

      // GET /categories
      if (endpoint === "/categories") {
        const { data, error } = await supabase
          .from("categories")
          .select("*")
          .order("name");
        if (error) throw error;
        return { data };
      }

      // GET /dashboard
      if (endpoint === "/dashboard") {
        const from = params.from || new Date().toISOString().slice(0, 10);
        const to = params.to || new Date().toISOString().slice(0, 10);

        // Use date range covering the full day
        const fromDt = `${from}T00:00:00`;
        const toDt = `${to}T23:59:59`;

        const { data, error } = await supabase
          .from("sales")
          .select("id, subtotal, tax, total, payment_method, created_at")
          .gte("created_at", fromDt)
          .lte("created_at", toDt);

        if (error) throw error;

        // Payment split
        const paymentSplit = { cash: 0, card: 0, upi: 0 };
        (data || []).forEach(s => {
          const method = (s.payment_method || "cash").toLowerCase();
          paymentSplit[method] = (paymentSplit[method] || 0) + parseFloat(s.total || 0);
        });

        // Daily sales grouped by day
        const dailyMap = new Map();
        (data || []).forEach(s => {
          const day = s.created_at?.slice(0, 10);
          if (!day) return;
          dailyMap.set(day, (dailyMap.get(day) || 0) + parseFloat(s.total || 0));
        });
        const dailySales = Array.from(dailyMap.entries())
          .map(([day, total]) => ({ day, total }))
          .sort((a, b) => a.day.localeCompare(b.day));

        const summary = {
          orders: (data || []).length,
          revenue: (data || []).reduce((sum, s) => sum + parseFloat(s.total || 0), 0),
          expenses: 0,
          total_products: (data || []).reduce((sum, s) => sum + 1, 0)
        };

        return { data: { summary, dailySales, paymentSplit } };
      }

      // GET /sales/:id
      // FIX 2: Map sale_items fields to what POS.jsx expects (name, qty, price, discount)
      if (endpoint.match(/^\/sales\/\d+$/)) {
        const saleId = endpoint.split("/")[2];
        const { data, error } = await supabase
          .from("sales")
          .select(`
            id,
            customer,
            phone,
            address,
            gst_number,
            subtotal,
            tax,
            total,
            payment_method,
            created_at,
            bill_number,
            sale_items(
              id,
              product_id,
              name,
              qty,
              price,
              discount,
              description,
              cgst,
              sgst
            )
          `)
          .eq("id", saleId)
          .maybeSingle();

        if (error) throw error;
        if (!data) return { data: null };

        // Normalize items to what Receipt component expects
        return {
          data: {
            ...data,
            gst_number: data.gst_number,
            items: (data.sale_items || []).map(item => ({
              product_id: item.product_id,
              name: item.name,
              qty: item.qty,
              price: item.price,
              discount: item.discount || 0,
              description: item.description || "",
              cgst: item.cgst ?? 9,
              sgst: item.sgst ?? 9
            }))
          }
        };
      }

      // GET /users
      if (endpoint === "/users") {
        const { data, error } = await supabase
          .from("users")
          .select("id, username, role, active");

        if (error) throw error;
        return { data };
      }

      // GET /customers
      if (endpoint === "/customers") {
        let query = supabase
          .from("sales")
          .select("customer, phone, created_at, total")
          .order("created_at", { ascending: false });

        if (params.search) {
          query = query.or(`customer.ilike.%${params.search}%,phone.ilike.%${params.search}%`);
        }

        const { data, error } = await query;
        if (error) throw error;

        // Deduplicate and aggregate
        const customerMap = new Map();
        (data || []).forEach(sale => {
          const key = sale.phone || sale.customer;
          if (!customerMap.has(key)) {
            customerMap.set(key, {
              customer: sale.customer,
              phone: sale.phone || "-",
              visits: 0,
              spend: 0,
              last_visit: sale.created_at
            });
          }
          const c = customerMap.get(key);
          c.visits += 1;
          c.spend += parseFloat(sale.total || 0);
          if (!c.last_visit || new Date(sale.created_at) > new Date(c.last_visit)) {
            c.last_visit = sale.created_at;
          }
        });

        return { data: Array.from(customerMap.values()) };
      }

      // GET /customers/:phone/history
      // FIX 3: was querying by customer_phone which doesn't exist — correct column is `phone`
      if (endpoint.includes("/customers/") && endpoint.includes("/history")) {
        const phone = endpoint.split("/customers/")[1].split("/history")[0];
        const decodedPhone = decodeURIComponent(phone);

        const { data, error } = await supabase
          .from("sales")
          .select(`
            id,
            customer,
            phone,
            subtotal,
            tax,
            total,
            payment_method,
            created_at,
            bill_number,
            sale_items(
              id,
              product_id,
              name,
              qty,
              price,
              discount,
              description,
              cgst,
              sgst
            )
          `)
          .eq("phone", decodedPhone)          // FIX: was .eq("customer_phone", ...) 
          .order("created_at", { ascending: false });

        if (error) throw error;

        // Normalize items shape
        return {
          data: (data || []).map(sale => ({
            ...sale,
            items: (sale.sale_items || []).map(item => ({
              product_id: item.product_id,
              name: item.name,
              qty: item.qty,
              price: item.price,
              discount: item.discount || 0,
              description: item.description || "",
              cgst: item.cgst ?? 9,
              sgst: item.sgst ?? 9
            }))
          }))
        };
      }

      // GET /reports/daily
      if (endpoint === "/reports/daily") {
        const from = params.from || new Date().toISOString().slice(0, 10);
        const to = params.to || new Date().toISOString().slice(0, 10);

        const { data, error } = await supabase
          .from("sales")
          .select("id, total, payment_method, created_at")
          .gte("created_at", `${from}T00:00:00`)
          .lte("created_at", `${to}T23:59:59`)
          .order("created_at", { ascending: false });

        if (error) throw error;
        return { data: data || [] };
      }

      // GET /reports/transactions
      if (endpoint === "/reports/transactions") {
        const from = params.from || new Date().toISOString().slice(0, 10);
        const to = params.to || new Date().toISOString().slice(0, 10);

        const { data, error } = await supabase
          .from("sales")
          .select(`
            id,
            customer,
            phone,
            subtotal,
            tax,
            total,
            payment_method,
            created_at
          `)
          .gte("created_at", `${from}T00:00:00`)
          .lte("created_at", `${to}T23:59:59`)
          .order("created_at", { ascending: false });

        if (error) throw error;

        // Remap to what Reports component expects (customer_name, customer_phone)
        return {
          data: (data || []).map(s => ({
            ...s,
            customer_name: s.customer,
            customer_phone: s.phone
          }))
        };
      }

      // GET /exports/:format
      if (endpoint.includes("/exports/")) {
        const format = endpoint.split("/exports/")[1];
        const from = params.from || new Date().toISOString().slice(0, 10);
        const to = params.to || new Date().toISOString().slice(0, 10);

        const { data, error } = await supabase
          .from("sales")
          .select("id, customer, phone, subtotal, tax, total, payment_method, created_at")
          .gte("created_at", `${from}T00:00:00`)
          .lte("created_at", `${to}T23:59:59`)
          .order("created_at", { ascending: false });

        if (error) throw error;

        let content;
        if (format === "xlsx" || format === "csv") {
          const headers = ["ID", "Customer", "Phone", "Subtotal", "Tax", "Total", "Payment", "Date"];
          const rows = (data || []).map(s => [
            s.id, s.customer, s.phone, s.subtotal, s.tax, s.total, s.payment_method, s.created_at
          ]);
          content = [headers, ...rows].map(row => row.join(",")).join("\n");
        } else {
          content = JSON.stringify(data, null, 2);
        }

        const blob = new Blob([content], { type: "application/octet-stream" });
        return { data: blob };
      }

      // GET /expenses
      if (endpoint === "/expenses") {
        const from = params.from || new Date().toISOString().slice(0, 10);
        const to = params.to || new Date().toISOString().slice(0, 10);

        const { data, error } = await supabase
          .from("expenses")
          .select("*")
          .gte("expense_date", from)
          .lte("expense_date", to)
          .order("expense_date", { ascending: false });

        if (error) throw error;
        return { data: data || [] };
      }

      console.warn(`[API] GET endpoint not implemented: ${endpoint}`);
      return { data: [] };
    } catch (error) {
      console.error(`[API] GET ${endpoint} error:`, error);
      throw error;
    }
  }
};

export function setAuthToken(token) {
  if (token) {
    sessionStorage.setItem("auth-token", token);
  } else {
    sessionStorage.removeItem("auth-token");
  }
}

export default api;