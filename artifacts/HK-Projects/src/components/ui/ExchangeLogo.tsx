export type ExchangeKey = "lighter" | "extended";

interface ExchangeLogoProps {
  exchange: ExchangeKey;
  size?: number;
  className?: string;
}

export function ExchangeLogo({ exchange, size = 16, className = "" }: ExchangeLogoProps) {
  const src =
    exchange === "lighter"
      ? "/images/lighter-icon.png"
      : "/images/extended-icon.png";

  const alt =
    exchange === "lighter"
      ? "Lighter DEX"
      : "Extended DEX";

  return (
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      className={`rounded-sm object-contain shrink-0 ${className}`}
      style={{ imageRendering: "auto" }}
    />
  );
}
