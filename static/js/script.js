console.log("✅ script.js 已載入");

async function runCommand() {
  const cmd = document.getElementById("cmdInput").value;
  const outputArea = document.getElementById("output");
  outputArea.textContent = "執行中...";

  const res = await fetch("/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: cmd }),
  });

  const data = await res.json();
  outputArea.textContent = data.output;
}
