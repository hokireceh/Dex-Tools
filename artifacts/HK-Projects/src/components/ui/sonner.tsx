import { Toaster as Sonner } from "sonner"

export function Toaster() {
  return (
    <Sonner
      theme="dark"
      position="bottom-right"
      duration={2500}
      toastOptions={{
        style: {
          background: "rgba(15, 15, 26, 0.7)",
          backdropFilter: "blur(12px)",
          border: "1px solid rgba(255,255,255,0.08)",
          color: "#f1f5f9",
        },
      }}
    />
  )
}
