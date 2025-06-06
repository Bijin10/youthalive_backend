"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.webhookHandler = exports.listEvents = void 0;
const jotform_service_1 = require("../services/jotform.service");
const qr_service_1 = require("../services/qr.service");
const email_service_1 = require("../services/email.service");
const event_model_1 = require("../models/event.model");
const user_model_1 = require("../models/user.model");
const ticket_model_1 = require("../models/ticket.model");
const logger_1 = __importDefault(require("../utils/logger"));
/**
 * Get all live events
 * @route GET /api/events
 */
const listEvents = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        // Get events from Jotform API
        const jotformEvents = yield (0, jotform_service_1.getLiveEvents)(); // Ensure all events exist in our database
        for (const jotformEvent of jotformEvents) {
            // Additional validation before saving to database
            const startTime = jotformEvent.startTime && !isNaN(jotformEvent.startTime.getTime())
                ? jotformEvent.startTime
                : new Date();
            const endTime = jotformEvent.endTime && !isNaN(jotformEvent.endTime.getTime())
                ? jotformEvent.endTime
                : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
            yield event_model_1.Event.findOneAndUpdate({ formId: jotformEvent.formId }, {
                formId: jotformEvent.formId,
                title: jotformEvent.title,
                startTime,
                endTime,
            }, { upsert: true, new: true });
        }
        // Get events from our database (with additional fields if needed)
        const events = yield event_model_1.Event.find({ formId: { $in: jotformEvents.map(e => e.formId) } }).sort({ startTime: 1 });
        // Return events
        res.status(200).json({
            success: true,
            count: events.length,
            data: events,
        });
    }
    catch (error) {
        logger_1.default.error('Error fetching events', { error });
        res.status(500).json({
            success: false,
            message: 'Error fetching events',
        });
    }
});
exports.listEvents = listEvents;
/**
 * Handle webhook from Jotform submissions
 * @route POST /api/events/webhook
 */
const webhookHandler = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        // Log the entire request for debugging
        logger_1.default.info('Full webhook request details', {
            headers: req.headers,
            body: req.body,
            query: req.query,
            params: req.params,
            method: req.method,
            url: req.url,
            rawBody: JSON.stringify(req.body)
        });
        logger_1.default.info('Received webhook payload', { body: req.body });
        // Parse the webhook data
        const submissionData = (0, jotform_service_1.parseWebhook)(req.body);
        logger_1.default.info('Parsed submission data', { submissionData });
        // Validate required fields
        if (!submissionData.email || !submissionData.formId || !submissionData.invoiceNo) {
            logger_1.default.warn('Missing required fields', {
                email: submissionData.email,
                formId: submissionData.formId,
                invoiceNo: submissionData.invoiceNo
            });
            res.status(400).json({
                success: false,
                message: 'Invalid webhook data: missing required fields',
                received: {
                    email: submissionData.email,
                    formId: submissionData.formId,
                    invoiceNo: submissionData.invoiceNo
                }
            });
            return;
        }
        // Find or create the event
        let event = yield event_model_1.Event.findOne({ formId: submissionData.formId });
        if (!event) {
            // Create a new event if it doesn't exist
            event = new event_model_1.Event({
                formId: submissionData.formId,
                title: submissionData.eventName || 'Youth Alive Event',
                startTime: new Date(), // Default values
                endTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days from now
            });
            yield event.save();
        } // Find or create the user
        let user = yield user_model_1.User.findOne({ email: submissionData.email });
        if (!user) {
            // Create a user with a random password (they can use password reset to set their own)
            const bcrypt = require('bcrypt');
            const tempPassword = Math.random().toString(36).slice(-8);
            const saltRounds = 10;
            const hashedPassword = yield bcrypt.hash(tempPassword, saltRounds);
            user = new user_model_1.User({
                email: submissionData.email,
                passwordHash: hashedPassword,
            });
            yield user.save();
            logger_1.default.info('Created new user for ticket', {
                email: submissionData.email,
                tempPassword: tempPassword // Log temp password for debugging (remove in production)
            });
        } // Check if ticket already exists
        let ticket = yield ticket_model_1.Ticket.findOne({ invoiceNo: submissionData.invoiceNo });
        if (!ticket) { // Create a new ticket      
            ticket = new ticket_model_1.Ticket({
                invoiceNo: submissionData.invoiceNo,
                user: user._id,
                event: event._id,
                name: submissionData.name,
                email: submissionData.email,
                phone: submissionData.phone,
                church: submissionData.church,
                youthMinistry: submissionData.youthMinistry,
                quantity: submissionData.quantity || 1,
                productDetails: submissionData.productDetails,
                totalAmount: submissionData.totalAmount
            });
            yield ticket.save(); // Generate QR code
            const qrDataUrl = yield (0, qr_service_1.generateQrCode)(submissionData.invoiceNo);
            // Send confirmation email with QR code
            yield email_service_1.emailService.sendTicketEmail({
                to: submissionData.email,
                name: submissionData.name,
                eventTitle: event.title,
                eventDate: submissionData.eventDate || event.startTime.toLocaleDateString(),
                invoiceNo: submissionData.invoiceNo,
                qrDataUrl: qrDataUrl
            });
        }
        // Return success response
        res.status(200).json({
            success: true,
            message: 'Webhook processed successfully',
            ticketId: ticket._id,
        });
    }
    catch (error) {
        logger_1.default.error('Error processing webhook', { error });
        res.status(500).json({
            success: false,
            message: 'Error processing webhook',
        });
    }
});
exports.webhookHandler = webhookHandler;
//# sourceMappingURL=event.controller.js.map