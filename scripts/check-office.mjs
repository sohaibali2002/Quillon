// Exercises office-document generation the way the model tool does: builds
// xlsx/docx/pptx through runCode with captureFiles and validates the bytes.
import { runCode } from "../src/lib/sandbox.ts";

const xlsx = await runCode({
  language: "javascript",
  code: `
const ExcelJS = require("exceljs");
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("Q1");
ws.addRow(["Region", "Revenue"]).font = { bold: true };
ws.addRow(["EMEA", 120]);
wb.xlsx.writeFile("out.xlsx").then(() => console.log("xlsx done"));
`,
  captureFiles: true,
});
const xa = xlsx.capturedFiles?.[0];
if (!xa) throw new Error("xlsx capture failed: " + xlsx.stderr);
if (Buffer.from(xa.base64, "base64").subarray(0, 2).toString() !== "PK") throw new Error("xlsx bytes not a zip");
console.log("xlsx ok:", xa.name, xa.bytes, "bytes");

const docx = await runCode({
  language: "javascript",
  code: `
const { Document, Packer, Paragraph, HeadingLevel, TextRun } = require("docx");
const doc = new Document({ sections: [{ children: [
  new Paragraph({ text: "Report", heading: HeadingLevel.HEADING_1 }),
  new Paragraph({ children: [new TextRun("Quarterly summary.")] }),
] }] });
Packer.toBuffer(doc).then((b) => require("fs").writeFileSync("out.docx", b));
`,
  captureFiles: true,
});
const da = docx.capturedFiles?.[0];
if (!da) throw new Error("docx capture failed: " + docx.stderr);
if (Buffer.from(da.base64, "base64").subarray(0, 2).toString() !== "PK") throw new Error("docx bytes not a zip");
console.log("docx ok:", da.name, da.bytes, "bytes");

const pptx = await runCode({
  language: "javascript",
  code: `
const PptxGenJS = require("pptxgenjs");
const p = new PptxGenJS();
const s = p.addSlide();
s.addText("Q1 Review", { x: 1, y: 1, fontSize: 32 });
p.writeFile({ fileName: "out.pptx" }).then(() => console.log("pptx done"));
`,
  captureFiles: true,
});
const pa = pptx.capturedFiles?.[0];
if (!pa) throw new Error("pptx capture failed: " + pptx.stderr);
if (Buffer.from(pa.base64, "base64").subarray(0, 2).toString() !== "PK") throw new Error("pptx bytes not a zip");
console.log("pptx ok:", pa.name, pa.bytes, "bytes");

// Python path with openpyxl too.
const py = await runCode({
  language: "python",
  code: `
from openpyxl import Workbook
wb = Workbook(); ws = wb.active; ws["A1"] = "hello"
wb.save("py.xlsx"); print("py done")
`,
  captureFiles: true,
});
const ya = py.capturedFiles?.[0];
if (!ya) throw new Error("python xlsx capture failed: " + py.stderr);
if (Buffer.from(ya.base64, "base64").subarray(0, 2).toString() !== "PK") throw new Error("python xlsx not a zip");
console.log("python xlsx ok:", ya.name, ya.bytes, "bytes");

console.log("ALL OFFICE CHECKS PASSED");
