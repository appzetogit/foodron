import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@food/components/ui/dialog"
import { Button } from "@food/components/ui/button"

export default function DeleteOrderModal({ isOpen, onOpenChange, order, onConfirm, isProcessing }) {
  if (!order) return null

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px] bg-white p-6 rounded-2xl">
        <DialogHeader>
          <DialogTitle>Delete Order</DialogTitle>
          <DialogDescription className="mt-2 text-slate-500">
            Delete order <span className="font-semibold text-slate-700">{order.orderId}</span> permanently?
            This will remove it from customer and delivery apps as well. This action cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-100">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isProcessing}
          >
            Cancel
          </Button>
          <Button
            type="button"
            className="bg-rose-600 hover:bg-rose-700 text-white"
            onClick={() => onConfirm(order)}
            disabled={isProcessing}
          >
            {isProcessing ? "Deleting..." : "Delete Order"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
