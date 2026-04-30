export async function printReceipt(pageSize) {
  // @page MUST be top-level CSS — nesting it inside @media print is invalid and ignored.
  // We set body width to match the paper width so Chromium renders at the right size.
  const styleId = "__pos_page_size_style__";
  let style = document.getElementById(styleId);
  if (!style) {
    style = document.createElement("style");
    style.id = styleId;
    document.head.appendChild(style);
  }

  if (pageSize === "A5") {
    style.textContent = `
      @page { size: 148mm 210mm portrait; margin: 0; }
      @media print {
        html, body, #root {
          width: 148mm !important; height: auto !important;
          margin: 0 !important; padding: 0 !important;
        }
      }
    `;
  } else if (pageSize === "80mm") {
    style.textContent = `
      @page { size: 80mm auto; margin: 0; }
      @media print {
        html, body, #root {
          width: 80mm !important; height: auto !important;
          margin: 0 !important; padding: 0 !important;
        }
      }
    `;
  } else {
    // A4: 210mm × 297mm
    style.textContent = `
      @page { size: 210mm 297mm portrait; margin: 0; }
      @media print {
        html, body, #root {
          width: 210mm !important; height: auto !important;
          margin: 0 !important; padding: 0 !important;
        }
      }
    `;
  }

  // Pass the paper size string directly — main.js converts to exact micron dimensions
  if (window.posPrinter?.printReceipt) {
    return window.posPrinter.printReceipt({ pageSize });
  }

  window.print();
  return true;
}

