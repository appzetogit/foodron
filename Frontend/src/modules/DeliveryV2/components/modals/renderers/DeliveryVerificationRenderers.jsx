import React from 'react';
import { Camera, Image as ImageIcon, Loader2, CheckCircle2 } from 'lucide-react';

export const RenderDeliveryVerification = ({ order, onComplete, onClose, children }) => {
  const moduleType = String(order?.module || order?.orderType || order?.serviceType || order?.type || '').toLowerCase();
  
  if (moduleType === 'parcel') {
    // Basic parcel renderer that can be extended with photo proof later.
    // For now we render the default children which is the ForwardDeliveryVerificationModal or ReturnSellerOtpModal
    return children;
  }
  
  return children;
};
