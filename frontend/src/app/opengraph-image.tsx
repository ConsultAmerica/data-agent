import { ImageResponse } from "next/og";

export const alt =
  "Dataomatix — source-grounded extraction for federal contracts";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const FIELDS = [
  ["Contract No.", "W91ZZZ26C0042", "85%"],
  ["FAR 52.212-4", "Incorporated by reference", "80%"],
  ["Issued by", "2 candidates", "50% · review"],
] as const;

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          background:
            "linear-gradient(120deg, #071d26 0%, #07383d 55%, #0a6eb4 100%)",
          color: "#f7fafa",
          padding: "64px 72px",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            width: "56%",
          }}
        >
          <div style={{ display: "flex", fontSize: 34, fontWeight: 700 }}>
            Data<span style={{ color: "#7ee8f8" }}>omatix</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 60, fontWeight: 700, lineHeight: 1.08 }}>
              Federal contract extraction you can verify.
            </div>
            <div
              style={{
                marginTop: 24,
                fontSize: 26,
                lineHeight: 1.4,
                color: "rgba(247,250,250,0.82)",
              }}
            >
              Every field boxed on the source page. Uncertain fields route to
              a reviewer. Oracle-ready export.
            </div>
          </div>
          <div style={{ fontSize: 20, color: "#7ee8f8" }}>
            FAR · DFARS · CLINs · ACRN funding · SF 1449
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginLeft: "auto",
            width: "38%",
            alignSelf: "center",
            background: "#f7fafa",
            color: "#071d26",
            borderRadius: 20,
            padding: 28,
          }}
        >
          {FIELDS.map(([label, value, conf]) => {
            const flagged = conf.includes("review");
            return (
              <div
                key={label}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  marginBottom: 16,
                  padding: "14px 16px",
                  borderRadius: 10,
                  border: `2px solid ${flagged ? "#c58b27" : "#1498c8"}`,
                  background: flagged
                    ? "rgba(197,139,39,0.10)"
                    : "rgba(20,152,200,0.08)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 16,
                    color: "#4a6168",
                  }}
                >
                  <span>{label}</span>
                  <span style={{ color: flagged ? "#8a6210" : "#0d5b61" }}>
                    {conf}
                  </span>
                </div>
                <div style={{ marginTop: 6, fontSize: 22, fontWeight: 700 }}>
                  {value}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    ),
    size,
  );
}
