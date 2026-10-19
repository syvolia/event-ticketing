import { Outlet } from 'react-router-dom';
import { Header } from './Header.js';

export function Layout(): JSX.Element {
  return (
    <div className="flex min-h-full flex-col">
      <Header />
      <main className="mx-auto w-full max-w-md flex-1 px-4 py-4">
        <Outlet />
      </main>
    </div>
  );
}
