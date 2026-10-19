import { Route, Routes, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout.js';
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
      {/* The scanner runs full-screen, no header — it is a separate
          operational surface from the buyer flow. */}
      <Route path="/scan" element={<ScanPage />} />

      {/* Everything else shares the buyer header + layout. */}
      <Route element={<Layout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/events/:id" element={<EventDetailPage />} />
        <Route path="/checkout/:orderId" element={<CheckoutPage />} />
        <Route path="/payment/:orderId" element={<PaymentPendingPage />} />
        <Route path="/orders/:orderId/success" element={<OrderSuccessPage />} />
        <Route path="/tickets" element={<MyTicketsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
