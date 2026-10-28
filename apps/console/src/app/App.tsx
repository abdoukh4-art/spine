import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router';
import { Shell } from './Shell';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, retry: 1, refetchOnWindowFocus: true } },
});

/** Root component. Phase 0 scaffold: routing + data layer; features land in Phase 1/2. */
export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="*" element={<Shell />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
