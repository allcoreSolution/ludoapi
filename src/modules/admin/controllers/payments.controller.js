"use strict";

const asyncHandler = require("../../../../utils/asyncHandler");
const paymentService = require("../../wallet/services/payment.service");

// GET /api/admin/deposits?page&limit&status&search
exports.listDeposits = asyncHandler(async (req, res) => {
  const { page, limit, status, search } = req.query;

  const result = await paymentService.listAdminDeposits({
    page,
    limit,
    status,
    search,
  });

  res.json({
    success: true,
    data: result,
  });
});

// PATCH /api/admin/deposits/:id/approve
exports.approveDeposit = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const adminId = req.admin._id;
  const { adminNote } = req.body;

  const result = await paymentService.approveDeposit(id, adminId, {
    adminNote,
  });

  res.json({
    success: true,
    message: "Deposit approved and coins credited to user wallet successfully",
    data: result,
  });
});

// PATCH /api/admin/deposits/:id/reject
exports.rejectDeposit = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const adminId = req.admin._id;
  const { rejectionReason, adminNote } = req.body;

  const result = await paymentService.rejectDeposit(id, adminId, {
    rejectionReason,
    adminNote,
  });

  res.json({
    success: true,
    message: "Deposit rejected",
    data: result,
  });
});

// GET /api/admin/withdrawals?page&limit&status&search
exports.listWithdrawals = asyncHandler(async (req, res) => {
  const { page, limit, status, search } = req.query;

  const result = await paymentService.listAdminWithdrawals({
    page,
    limit,
    status,
    search,
  });

  res.json({
    success: true,
    data: result,
  });
});

// PATCH /api/admin/withdrawals/:id/approve
exports.approveWithdrawal = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const adminId = req.admin._id;
  const { transactionRef, adminNote } = req.body;

  const result = await paymentService.approveWithdrawal(id, adminId, {
    transactionRef,
    adminNote,
  });

  res.json({
    success: true,
    message: "Withdrawal approved successfully",
    data: result,
  });
});

// PATCH /api/admin/withdrawals/:id/reject
exports.rejectWithdrawal = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const adminId = req.admin._id;
  const { rejectionReason, adminNote } = req.body;

  const result = await paymentService.rejectWithdrawal(id, adminId, {
    rejectionReason,
    adminNote,
  });

  res.json({
    success: true,
    message: "Withdrawal rejected and coins refunded to user wallet",
    data: result,
  });
});
