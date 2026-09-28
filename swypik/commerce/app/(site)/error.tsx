"use client";

import RouteError from "@/components/layout/RouteError";

export default function ErrorPage(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError {...props} />;
}
