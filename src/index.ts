import express from 'express';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import FormData from 'form-data';
import dotenv from 'dotenv';
import TelegramBot, {Update} from "node-telegram-bot-api";
import {extname} from 'path';

dotenv.config();

const token = process.env.TOKEN as string;
const astrometryKey = process.env.ASTROMETRY_KEY;
const default_url = process.env.API_URL;
const port = process.env.PORT || 8080; // Default port for Cloud Run

const app = express();

// Parse incoming JSON payloads
app.use(express.json());

// Initialize Telegram Bot without polling
const bot = new TelegramBot(token);

// Set up the webhook route
app.post('/webhook', async (req: any, res: any) => {
    const update: Update = req.body;

    if (update.message) {
        await handleMessage(update.message);
    }

    res.status(200).send('OK');
});

// Rate limiting (In-memory for simplicity; consider persistent storage for scalability)
const userLastRequest: { [key: number]: number } = {};
const RATE_LIMIT_MS = 60 * 1000; // 1 minute

// Message handler
const handleMessage = async (msg: TelegramBot.Message) => {
    const chatId = msg.chat.id;

    const now = Date.now();
    if (userLastRequest[chatId] && (now - userLastRequest[chatId]) < RATE_LIMIT_MS) {
        await bot.sendMessage(chatId, '⏳ Please wait a minute before submitting another image.');
        return;
    }
    userLastRequest[chatId] = now;

    if (msg.photo) {
        const file_id = msg.photo[msg.photo.length - 1].file_id;

        try {
            const fileInfo = await bot.getFile(file_id);
            const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;

            // Validate file extension
            // @ts-ignore
            const fileExtension = extname(fileInfo.file_path).toLowerCase();
            const allowedExtensions = ['.jpg', '.jpeg', '.png', '.bmp', '.tif', '.tiff'];
            if (!allowedExtensions.includes(fileExtension)) {
                await bot.sendMessage(chatId, '❌ Unsupported file format. Please send an image in JPG, PNG, BMP, or TIFF format.');
                return;
            }

            // Check file size (optional)
            const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
            if (fileInfo.file_size && fileInfo.file_size > MAX_FILE_SIZE) {
                await bot.sendMessage(chatId, '⚠️ The image is too large. Please send an image smaller than 10MB.');
                return;
            }

            const filePath = await downloadImage(fileUrl, fileInfo.file_path as string);
            const submissionId = await submitToAstrometry(filePath as string);

            if (!submissionId) {
                throw new Error('❌ Failed to obtain submission ID.');
            }

            await bot.sendMessage(chatId, '📥 Image received! Plate solving has started. This may take a few minutes. You will be notified once it\'s complete.');

            const result: any = await getAstrometryResult(submissionId);

            if (result) {
                // Extract job_id from the result
                const jobId = result.job_id;
                if (!jobId) {
                    console.error('❌ job_id is missing in the calibration data.');
                    await bot.sendMessage(chatId, '❌ Plate solving was successful, but the job ID is unavailable.');
                    return;
                }

                // Construct URLs
                const annotatedDisplayUrl = `http://nova.astrometry.net/annotated_display/${jobId}`;
                const redGreenImageUrl = `http://nova.astrometry.net/red_green_image_display/${jobId}`;
                const extractionImageUrl = `http://nova.astrometry.net/extraction_image_display/${jobId}`;

                // Send the annotated image to the user
                await bot.sendPhoto(chatId, annotatedDisplayUrl, {
                    caption: '🌟 *Plate Solving Successful!*\nHere is your plate-solved image.',
                    parse_mode: 'Markdown',
                });

                // Send the RedGreen image to the user
                await bot.sendPhoto(chatId, redGreenImageUrl, {
                    caption: '🔴🔵 *Plate Solving Successful!*\nHere is your red-green image.',
                    parse_mode: 'Markdown',
                });

                // Send the extraction image to the user
                await bot.sendPhoto(chatId, extractionImageUrl, {
                    caption: '🔴🔵 *Plate Solving Successful!*\nHere is your Extraction image.',
                    parse_mode: 'Markdown',
                });

                const calibrationDetails = `📋 *Calibration Details:*\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
                await bot.sendMessage(chatId, calibrationDetails, {parse_mode: 'Markdown'});
            } else {
                await bot.sendMessage(chatId, `❌ Plate solving failed or is taking too long.`);
            }

            // Optional: Clean up downloaded file
            fs.unlink(filePath, (err) => {
                if (err) {
                    console.error(`❌ Failed to delete file ${filePath}:`, err);
                } else {
                    console.log(`🗑️ Deleted file ${filePath}`);
                }
            });
        } catch (error) {
            console.error(error);
            await bot.sendMessage(chatId, '⚠️ An error occurred while processing your image.');
        }
    } else {
        await bot.sendMessage(chatId, '📷 Please send an image for plate-solving.');
    }
};

// Download Image Function
async function downloadImage(url: string, filePath: string) {
    const downloadsDir = path.join('/tmp'); // Use /tmp for Cloud Run

    // Ensure the downloads directory exists
    if (!fs.existsSync(downloadsDir)) {
        fs.mkdirSync(downloadsDir, {recursive: true});
    }

    const localPath = path.join(downloadsDir, path.basename(filePath));
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`❌ Failed to download image: ${response.status} ${response.statusText}`);
    }

    const buffer = await response.buffer();
    fs.writeFileSync(localPath, buffer);
    console.log(`✅ Image downloaded to ${localPath}`);
    return localPath;
}

// Submit to Astrometry.net Function
async function submitToAstrometry(filePath: string) {
    try {
        // Step 1: Login to Astrometry.net
        const loginResponse = await fetch(`${default_url}login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                'request-json': JSON.stringify({apikey: astrometryKey}),
            }),
        });

        if (!loginResponse.ok) {
            const errorText = await loginResponse.text();
            console.error(`❌ Login failed: ${loginResponse.status} ${loginResponse.statusText}`);
            console.error(`Response: ${errorText}`);
            throw new Error(`Login failed with status: ${loginResponse.status}`);
        }

        const loginData: any = await loginResponse.json();
        console.log(`✅ Logged in successfully. Session key: ${loginData.session}`);

        const sessionKey = loginData.session;

        // Step 2: Prepare form data for image upload
        const form = new FormData();
        form.append('request-json', JSON.stringify({
            publicly_visible: "y",
            allow_modifications: "d",
            session: sessionKey,
            allow_commercial_use: "d",
        }));

        form.append('file', fs.createReadStream(filePath));

        // Step 3: Calculate Content-Length
        const contentLength = await new Promise<number>((resolve, reject) => {
            form.getLength((err, length) => {
                if (err) reject(err);
                resolve(length);
            });
        });

        // Step 4: Upload the image
        const uploadResponse = await fetch(`${default_url}upload`, {
            method: 'POST',
            body: form,
            headers: {
                ...form.getHeaders(),
                'Content-Length': contentLength.toString(),
            },
        });

        const uploadText = await uploadResponse.text();
        console.log(`📤 Upload response: ${uploadText}`);

        if (!uploadResponse.ok) {
            console.error(`❌ Upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`);
            console.error(uploadText);
            throw new Error(`Upload failed with status: ${uploadResponse.status}`);
        }

        const uploadData: any = JSON.parse(uploadText);
        console.log(`✅ Submission ID: ${uploadData.subid}`);

        // Ensure 'subid' is present and valid
        if (!uploadData.subid) {
            console.error("❌ Submission ID (subid) is missing in the upload response.");
            throw new Error("Invalid upload response: subid missing.");
        }

        return uploadData.subid;
    } catch (error) {
        console.error('❌ Error during submission to Astrometry.net:', error);
        throw error; // Re-throw to be caught in the main handler
    }
}

// Get Astrometry.net Result Function
async function getAstrometryResult(submissionId: string) {
    let jobId: string | null = null;
    const maxSubmissionRetries = 30; // Total attempts to fetch jobId
    const submissionRetryDelay = 5000; // 5 seconds between submission status checks

    // Step 1: Poll the submission status until a job is available or timeout is reached
    for (let i = 0; i < maxSubmissionRetries; i++) {
        try {
            const statusResponse = await fetch(`${default_url}submissions/${submissionId}`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                },
            });

            if (!statusResponse.ok) {
                const errorText = await statusResponse.text();
                console.error(`❌ Failed to fetch submission status: ${statusResponse.status} ${statusResponse.statusText}`);
                console.error(`Response: ${errorText}`);
                // Decide whether to continue or abort based on the status code
            } else {
                const statusData: any = await statusResponse.json();
                console.log(`🔄 Attempt ${i + 1}: Submission status data:`, statusData);

                if (statusData.jobs && statusData.jobs.length > 0 && statusData.jobs[0]) {
                    jobId = statusData.jobs[0];
                    console.log(`✅ Job ID found: ${jobId}`);
                    break;
                } else {
                    console.log(`ℹ️ No valid job ID found yet. Retrying...`);
                }
            }
        } catch (error) {
            console.error(`❌ Error fetching submission status on attempt ${i + 1}:`, error);
        }

        // Wait before the next retry
        await new Promise(resolve => setTimeout(resolve, submissionRetryDelay));
    }

    if (!jobId) {
        console.error("❌ No job ID found for submission after multiple retries.");
        return null;
    }

    // Step 2: Poll the job status until it's solved or failed
    const maxJobRetries = 30; // Total attempts to check job status
    const jobRetryDelay = 15000; // 15 seconds between job status checks
    let result: any = null;

    for (let i = 0; i < maxJobRetries; i++) {
        try {
            const jobStatusResponse = await fetch(`${default_url}jobs/${jobId}`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                },
            });

            if (!jobStatusResponse.ok) {
                const errorText = await jobStatusResponse.text();
                console.error(`❌ Failed to fetch job status: ${jobStatusResponse.status} ${jobStatusResponse.statusText}`);
                console.error(`Response: ${errorText}`);
                // Decide whether to continue or abort based on the status code
            } else {
                const jobStatusData: any = await jobStatusResponse.json();
                console.log(`🔄 Attempt ${i + 1}: Job status data:`, jobStatusData);

                if (jobStatusData.status === 'solving') {
                    // Still solving, continue polling
                    console.log(`⏳ Job ${jobId} is still solving...`);
                } else if (jobStatusData.status === 'success') {
                    // Fetch calibration result once solved
                    try {
                        const resultResponse = await fetch(`${default_url}jobs/${jobId}/calibration`, {
                            method: 'GET',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                        });

                        if (resultResponse.ok) {
                            result = await resultResponse.json();
                            result.job_id = jobId;
                            console.log(`✅ Job ${jobId} solved successfully.`);
                            break;
                        } else {
                            const errorText = await resultResponse.text();
                            console.error(`❌ Failed to fetch calibration: ${resultResponse.status} ${resultResponse.statusText}`);
                            console.error(`Response: ${errorText}`);
                        }
                    } catch (error) {
                        console.error(`❌ Error fetching calibration for job ${jobId}:`, error);
                    }
                } else if (jobStatusData.status === 'failure') {
                    console.error(`❌ Job ${jobId} failed.`);
                    break;
                } else {
                    console.warn(`⚠️ Unknown job status: ${jobStatusData.status}`);
                }
            }
        } catch (error) {
            console.error(`❌ Error fetching job status on attempt ${i + 1}:`, error);
        }

        // Wait before the next retry
        await new Promise(resolve => setTimeout(resolve, jobRetryDelay));
    }

    return result;
}

// Start the Express server
app.listen(port, () => {
    console.log(`🚀 Telegram bot is running on port ${port}`);
});
