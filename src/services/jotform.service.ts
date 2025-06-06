import axios from 'axios';
import config from '../config';
import logger from '../utils/logger';

// Base URL for Jotform API
const JOTFORM_API_BASE_URL = 'https://api.jotform.com';

// Interface for Event data from Jotform
export interface JotformEvent {
  formId: string;
  title: string;
  startTime: Date;
  endTime: Date;
}

// Interface for parsed webhook data
export interface ParsedSubmission {
  email: string;
  name: string;
  invoiceNo: string;
  formId: string;
  phone?: string;
  church?: string;
  youthMinistry?: string;
  eventName?: string;
  eventDate?: string;
  quantity?: number;
  productDetails?: string;
  totalAmount?: number;
}

/**
 * Get live events from Jotform API
 * @returns Promise resolving to array of event objects
 */
export const getLiveEvents = async (): Promise<JotformEvent[]> => {
  try {
    // Make API request to get all forms
    const response = await axios.get(`${JOTFORM_API_BASE_URL}/user/forms`, {
      params: {
        apiKey: config.jotform.apiKey,
        limit: 100, // Adjust as needed
        filter: {
          status: 'ENABLED' // Only get active forms
        }
      }
    });    // Check if request was successful
    if (response.data.responseCode !== 200) {
      throw new Error(`Jotform API error: ${response.data.message}`);
    }

    // Extract and transform form data to our event format
    // Note: You might need to extract actual event dates from form questions
    const events: JotformEvent[] = response.data.content
      .filter((form: any) => form.status === 'ENABLED')
      .map((form: any) => {
        // Safe date parsing with robust validation
        let startTime: Date;
        let endTime: Date;
        
        try {
          // Try to parse the created_at timestamp
          if (form.created_at && typeof form.created_at === 'string' && !isNaN(Number(form.created_at))) {
            // Unix timestamp (string)
            startTime = new Date(parseInt(form.created_at) * 1000);
          } else if (form.created_at && typeof form.created_at === 'number' && !isNaN(form.created_at)) {
            // Unix timestamp (number)
            startTime = new Date(form.created_at * 1000);
          } else if (form.created_at && typeof form.created_at === 'string') {
            // Try direct string parsing
            startTime = new Date(form.created_at);
          } else {
            // No created_at, use current time
            startTime = new Date();
          }
          
          // Validate the parsed date is actually valid
          if (!startTime || isNaN(startTime.getTime()) || startTime.getTime() <= 0) {
            logger.warn(`Invalid startTime for form ${form.id}, using current date`, { 
              created_at: form.created_at, 
              parsed: startTime 
            });
            startTime = new Date();
          }
          
          // Set end time to 7 days after start time
          endTime = new Date(startTime.getTime() + 7 * 24 * 60 * 60 * 1000);
          
          // Validate end time as well
          if (!endTime || isNaN(endTime.getTime())) {
            endTime = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
          }
            } catch (error) {
          // Fallback dates in case of any parsing error
          logger.warn(`Exception parsing dates for form ${form.id}, using defaults`, { 
            error: error instanceof Error ? error.message : String(error), 
            created_at: form.created_at 
          });
          startTime = new Date();
          endTime = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        }
          return {
          formId: form.id,
          title: form.title,
          startTime,
          endTime,
        };
      });
    
    logger.info(`Retrieved ${events.length} live events from Jotform`);
    return events;
  } catch (error) {
    logger.error('Error fetching events from Jotform', { error: error instanceof Error ? error.message : String(error) });
    throw new Error('Failed to fetch events from Jotform');
  }
};

export const parseWebhook = (payload: any): ParsedSubmission => {
  console.log('Received webhook payload:', JSON.stringify(payload, null, 2));
  
  try {
    // Log the entire payload to understand its structure
    logger.info('Parsing webhook payload', { 
      payload, 
      keys: Object.keys(payload),
      formID: payload.formID || payload.formId
    });
    
    // Extract formID from the payload
    const formId = payload.formID || payload.form_id || payload.formId || '';
    
    // If payload has rawRequest field, try to parse it
    if (payload.rawRequest) {
      console.log('Found rawRequest field, attempting to parse...');
      
      try {
        const rawData = JSON.parse(payload.rawRequest);
        console.log('Parsed rawRequest:', JSON.stringify(rawData, null, 2));
          // Extract form fields from rawData
        const rawFields = rawData;
        const formFields: any = {};
        
        // Add the formId to the form fields
        formFields.formID = formId;
        formFields.formId = formId;
        
        // Process each field
        for (const [key, value] of Object.entries(rawFields)) {
          if (key.startsWith('q') && key.includes('_')) {
            // This is a form field
            formFields[key] = value;
          } else {
            // Copy all other fields too (including direct quantity, productDetails, etc.)
            formFields[key] = value;
          }
        }
        
        console.log('Extracted form fields:', JSON.stringify(formFields, null, 2));
        
        // Parse the extracted fields
        const ticketData = parseFormFields(formFields);
        console.log('Successfully parsed ticket data from rawRequest:', ticketData);
        return ticketData;
        
      } catch (parseError) {
        console.error('Failed to parse rawRequest:', parseError);
        // Fall through to try legacy parsing
      }
    }
    
    // Try legacy parsing if rawRequest parsing failed or doesn't exist
    console.log('Attempting legacy parsing...');
    const ticketData = parseFormFields(payload);
    console.log('Successfully parsed ticket data from legacy method:', ticketData);
    return ticketData;
    
  } catch (error) {
    console.error('Error in parseWebhook:', error);
    throw error;
  }
};

/**
 * Parse product details from JotForm's "My Products" field
 */
const parseProductDetails = (productField: any): { quantity: number; productDetails: string; totalAmount: number } => {
  let quantity = 1;
  let productDetails = '';
  let totalAmount = 0;

  try {
    console.log('Parsing product details from:', JSON.stringify(productField));
    
    if (productField && typeof productField === 'object') {
      // Check if it has paymentArray (typical format for Stadium 24 form)
      if (productField.paymentArray) {
        console.log('Found paymentArray:', productField.paymentArray);
        try {
          const paymentData = JSON.parse(productField.paymentArray);
          console.log('Parsed paymentArray:', JSON.stringify(paymentData));
          
          if (paymentData.product && Array.isArray(paymentData.product)) {
            // Extract quantity from product string like "General Admission (Amount: 5.00 AUD, Quantity: 15)"
            const productString = paymentData.product[0] || '';
            console.log('Product string:', productString);
            
            const quantityMatch = productString.match(/Quantity:\s*(\d+)/);
            if (quantityMatch) {
              quantity = parseInt(quantityMatch[1], 10) || 1;
              console.log('Extracted quantity:', quantity);
            }
            
            productDetails = productString;
          }
          
          if (paymentData.total) {
            totalAmount = parseFloat(paymentData.total) || 0;
            console.log('Extracted total amount:', totalAmount);
          }
        } catch (parseError) {
          console.error('Error parsing paymentArray:', parseError);
        }
      }
      
      // Check if it has the direct product data format
      if (productField['1']) {
        const productData = JSON.parse(productField['1']);
        if (productData.quantity) {
          quantity = parseInt(productData.quantity, 10) || 1;
        }
        if (productData.name) {
          productDetails = `${productData.name} (Quantity: ${quantity})`;
        }
        if (productData.price) {
          totalAmount = productData.price * quantity;
        }
      }
    } else if (typeof productField === 'string') {
      // Handle string format like "General Admission (Amount: 5.00 AUD, Quantity: 15)"
      const quantityMatch = productField.match(/Quantity:\s*(\d+)/);
      if (quantityMatch) {
        quantity = parseInt(quantityMatch[1], 10) || 1;
      }
      
      const amountMatch = productField.match(/Amount:\s*([\d.]+)/);
      if (amountMatch) {
        const unitPrice = parseFloat(amountMatch[1]) || 0;
        totalAmount = unitPrice * quantity;
      }
      
      productDetails = productField;
    }
  } catch (error) {
    logger.warn('Error parsing product details', { error, productField });
  }

  return { quantity, productDetails, totalAmount };
};

/**
 * Helper function to parse form fields and extract ticket data
 */
const parseFormFields = (fields: any): ParsedSubmission => {
  logger.info('Parsing form fields', { fields });
  
  const formId = fields.formID || fields.form_id || fields.formId || '';
  
  // Initialize default values
  let email = '';
  let name = '';  let invoiceNo = `INV-${Date.now()}`;
  let phone = '';
  let church = '';
  let quantity = 1;
  let productDetails = '';
  let totalAmount = 0;
    // FIRST: Try to extract from WebApp test form field names (the correct ones from logs)
  if (fields.q4_email4) {
    email = fields.q4_email4;
  } else if (fields.q5_email) {
    email = fields.q5_email;
  } else if (fields.q4_email) {
    email = fields.q4_email;
  } else if (fields.email) {
    email = fields.email;
  }

  // Handle different form types for name
  if (fields.q4_fullName || fields.q4_name) {
    // Stadium 24 form format - field 4 is name
    const nameValue = fields.q4_fullName || fields.q4_name;
    if (typeof nameValue === 'object' && nameValue !== null) {
      const nameObj = nameValue as any;
      name = `${nameObj.first || ''} ${nameObj.last || ''}`.trim();
    } else {
      name = String(nameValue);
    }
  } else if (fields.q3_ltstronggtnameltstronggt) {
    // WebApp test form format
    if (typeof fields.q3_ltstronggtnameltstronggt === 'object' && fields.q3_ltstronggtnameltstronggt !== null) {
      const nameObj = fields.q3_ltstronggtnameltstronggt as any;
      name = `${nameObj.first || ''} ${nameObj.last || ''}`.trim();
    } else {
      name = String(fields.q3_ltstronggtnameltstronggt);
    }
  } else if (fields.q3_name) {
    if (typeof fields.q3_name === 'object' && fields.q3_name !== null) {
      const nameObj = fields.q3_name as any;
      name = `${nameObj.first || ''} ${nameObj.last || ''}`.trim();
    } else {
      name = String(fields.q3_name);
    }
  } else if (fields['q3_name[first]'] && fields['q3_name[last]']) {
    name = `${fields['q3_name[first]']} ${fields['q3_name[last]']}`.trim();
  } else if (fields.name) {
    name = String(fields.name);
  }

  // Handle Stadium 24 form email (field 5)
  if (!email && fields.q5_email) {
    email = fields.q5_email;
  }
  // Handle product details from field 3 (Stadium 24 form) or other product fields
  if (fields.q3_products || fields.q3_myProducts || fields['3']) {
    const productField = fields.q3_products || fields.q3_myProducts || fields['3'];
    logger.info('Found product field', { productField });
    
    const parsed = parseProductDetails(productField);
    quantity = parsed.quantity;
    productDetails = parsed.productDetails;
    totalAmount = parsed.totalAmount;
    
    logger.info('Parsed product details', { quantity, productDetails, totalAmount });
  } else {
    logger.info('No product field found in submission');
  }

  // Handle phone numbers from different forms
  if (fields.q7_phone || fields.q7_phoneNumber) {
    // Stadium 24 form format
    phone = fields.q7_phone || fields.q7_phoneNumber;
  } else if (fields.q16_ltstronggtphoneNumberltstronggt) {
    // WebApp test form format
    phone = fields.q16_ltstronggtphoneNumberltstronggt;
  } else if (fields.q11_phoneNumber) {
    if (typeof fields.q11_phoneNumber === 'object' && fields.q11_phoneNumber !== null) {
      const phoneObj = fields.q11_phoneNumber as any;
      phone = phoneObj.full || String(fields.q11_phoneNumber);
    } else {
      phone = String(fields.q11_phoneNumber);
    }
  } else if (fields['q11_phoneNumber[full]']) {
    phone = fields['q11_phoneNumber[full]'];
  } else if (fields.phone) {
    phone = fields.phone;
  }

  // Handle church/youth group from different forms
  if (fields.q10_church || fields.q10_youthGroup) {
    // Stadium 24 form format  
    church = fields.q10_church || fields.q10_youthGroup;
  } else if (fields.q12_ltstronggtwhichYouth) {
    // WebApp test form format
    church = fields.q12_ltstronggtwhichYouth;
  } else if (fields.q9_youthGroup) {
    church = fields.q9_youthGroup;
  } else if (fields.q12_textbox) {
    church = fields.q12_textbox;
  } else if (fields.church || fields.youthGroup) {
    church = fields.church || fields.youthGroup;
  }

  // Handle invoice ID from different forms
  if (fields.q38_invoiceId || fields['38']) {
    // Stadium 24 form format
    invoiceNo = fields.q38_invoiceId || fields['38'];
  } else if (fields.q11_invoiceId) {
    // WebApp test form format
    invoiceNo = fields.q11_invoiceId;
  } else if (fields.q7_invoiceId) {
    invoiceNo = fields.q7_invoiceId;
  } else if (fields.q11_autoincrement) {
    invoiceNo = fields.q11_autoincrement;
  } else if (fields.invoiceId) {
    invoiceNo = fields.invoiceId;
  }
  // Clean invoice number (remove "# INV-" prefix if present)
  if (typeof invoiceNo === 'string' && invoiceNo.startsWith('# INV-')) {
    invoiceNo = invoiceNo.substring(6);
  }
  
  // Also handle "# " prefix without INV
  if (typeof invoiceNo === 'string' && invoiceNo.startsWith('# ')) {
    invoiceNo = invoiceNo.substring(2);
  }
  
  // Also handle just "INV-" prefix
  if (typeof invoiceNo === 'string' && invoiceNo.startsWith('INV-')) {
    invoiceNo = invoiceNo.substring(4);
  }
  logger.info('Final parsed submission data', {
    formId, email, name, invoiceNo, phone, church, quantity, productDetails, totalAmount
  });
    return {
    formId,
    email,
    name,
    invoiceNo,
    phone,
    church,
    quantity,
    productDetails,
    totalAmount,
  };
};