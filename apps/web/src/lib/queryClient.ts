import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // We rely on explicit refetchInterval where live data matters (event
      // availability, order status). For everything else, a minute of cache
      // is fine and cuts API traffic on mobile significantly.
      staleTime: 60_000,
      // Retry transient network errors but never retry on 4xx — a 404 or a
      // 409 is a decision, not a hiccup.
      retry: (failureCount, error) => {
        const status = (error as { status?: number }).status;
        if (status !== undefined && status >= 400 && status < 500) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: false,
    },
  },
});