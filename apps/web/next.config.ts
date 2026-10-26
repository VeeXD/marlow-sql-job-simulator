import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dev tools badge only exists in `next dev`. Turning it off keeps the
  // bottom-left corner clear there; production builds never render it.
  devIndicators: false,
};

export default nextConfig;
