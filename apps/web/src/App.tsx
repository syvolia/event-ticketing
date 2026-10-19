import { Route, Routes, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout.js';
import { RequireAuth } from './components/RequireAuth.js'; // <-- Import added
import { HomePage } from './pages/HomePage.js';
import { EventDetailPage } from './pages/EventDetailPage.js';
import { CheckoutPage } from './pages/CheckoutPage.js';
import { PaymentPendingPage } from './pages/PaymentPendingPage.js';
import { OrderSuccessPage } from './pages/OrderSuccessPage.js';
import { MyTicketsPage } from './pages/MyTicketsPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { RegisterPage } from './pages/RegisterPage.js';
import { ScanPage } from './pages/ScanPage.js';

export function App(): JSX.Element {
  return (
    <Routes>
      {/* Scanner has its own auth gate built-in, so it stays outside the layout */}
      <Route path="/scan" element={<ScanPage />} />

      <Route element={<Layout />}>
        {/* Public Auth Routes */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />

        {/* Protected Buyer Routes: if you are not logged in, you cannot see these */}
        <Route element={<RequireAuth />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/events/:id" element={<EventDetailPage />} />
          <Route path="/checkout/:orderId" element={<CheckoutPage />} />
          <Route path="/payment/:orderId" element={<PaymentPendingPage />} />
          <Route path="/orders/:orderId/success" element={<OrderSuccessPage />} />
          <Route path="/tickets" element={<MyTicketsPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
