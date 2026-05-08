const express = require('express');
const router = express.Router();
const Quiz = require('../models/Quiz');
const QuizAttempt = require('../models/QuizAttempt');
const User = require('../models/User');
const { OpenAI } = require('openai');
const auth = require('../middleware/auth');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Grade-level quiz templates
const gradeQuizTemplates = {
  'grade-1-3': {
    difficulty: 'easy',
    questionTypes: ['multiple-choice', 'true-false'],
    timePerQuestion: 120, // 2 minutes
    totalTime: 1200, // 20 minutes
    passingScore: 70,
  },
  'grade-4-6': {
    difficulty: 'medium',
    questionTypes: ['multiple-choice', 'short-answer', 'true-false'],
    timePerQuestion: 180, // 3 minutes
    totalTime: 1800, // 30 minutes
    passingScore: 75,
  },
  'grade-7-9': {
    difficulty: 'hard',
    questionTypes: ['multiple-choice', 'short-answer', 'essay'],
    timePerQuestion: 240, // 4 minutes
    totalTime: 2400, // 40 minutes
    passingScore: 80,
  },
  'grade-10-plus': {
    difficulty: 'advanced',
    questionTypes: ['multiple-choice', 'short-answer', 'essay', 'calculation'],
    timePerQuestion: 300, // 5 minutes
    totalTime: 3000, // 50 minutes
    passingScore: 85,
  },
};

// Generate AI Quiz
router.post('/generate', auth, async (req, res) => {
  try {
    const { topic, numberOfQuestions = 10 } = req.body;
    const userId = req.user.id;

    if (!topic || topic.trim().length === 0) {
      return res.status(400).json({ error: 'Topic cannot be empty' });
    }

    if (numberOfQuestions < 5 || numberOfQuestions > 20) {
      return res.status(400).json({ error: 'Number of questions must be between 5 and 20' });
    }

    // Get user details
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const gradeLevel = user.gradeLevel || 'grade-4-6';
    const template = gradeQuizTemplates[gradeLevel];

    // System prompt for quiz generation
    const systemPrompt = `You are an expert quiz creator for ${gradeLevel.replace('-', ' ')} students.
Create exactly ${numberOfQuestions} quiz questions about "${topic}".

Requirements:
- Difficulty: ${template.difficulty}
- Question types to use: ${template.questionTypes.join(', ')}
- Make it educational and fun for exam preparation
- Each question should be clear and age-appropriate

Return ONLY a valid JSON array (no markdown, no backticks) with this exact structure:
[
  {
    "id": 1,
    "question": "Question text here?",
    "type": "multiple-choice|true-false|short-answer|essay|calculation",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correctAnswer": "Option A",
    "explanation": "Why this answer is correct",
    "difficulty": "easy|medium|hard",
    "points": 10
  }
]

Only include "options" field for multiple-choice and true-false questions.
For short-answer, essay, and calculation: correctAnswer should be a brief correct response.`;

    // Call OpenAI to generate quiz
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: `Generate a ${numberOfQuestions} question quiz about "${topic}" for ${gradeLevel} students preparing for exams.`,
        },
      ],
      temperature: 0.8,
      max_tokens: 4000,
    });

    let questions;
    try {
      const responseText = completion.choices[0].message.content.trim();
      questions = JSON.parse(responseText);
    } catch (parseError) {
      console.error('JSON Parse error:', parseError);
      return res.status(500).json({ error: 'Failed to parse quiz data from AI' });
    }

    // Validate questions
    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(500).json({ error: 'Invalid quiz data received' });
    }

    // Create quiz document
    const quiz = new Quiz({
      userId,
      topic,
      title: `Quiz: ${topic}`,
      description: `A comprehensive ${numberOfQuestions}-question quiz about ${topic} for exam preparation`,
      questions: questions.map((q, index) => ({
        ...q,
        id: index + 1,
      })),
      numberOfQuestions: questions.length,
      totalPoints: questions.reduce((sum, q) => sum + (q.points || 10), 0),
      gradeLevel,
      difficulty: template.difficulty,
      timeLimit: template.totalTime,
      passingScore: template.passingScore,
      createdBy: 'ai',
    });

    await quiz.save();

    res.json({
      quizId: quiz._id,
      topic: quiz.topic,
      title: quiz.title,
      numberOfQuestions: quiz.numberOfQuestions,
      totalPoints: quiz.totalPoints,
      timeLimit: quiz.timeLimit,
      passingScore: quiz.passingScore,
      difficulty: quiz.difficulty,
      gradeLevel: quiz.gradeLevel,
      questions: questions.map(q => ({
        id: q.id,
        question: q.question,
        type: q.type,
        options: q.options,
        difficulty: q.difficulty,
        points: q.points,
        // Don't send correct answers yet
      })),
      message: `Quiz generated successfully! ${numberOfQuestions} questions ready. Good luck! 📚`,
    });
  } catch (error) {
    console.error('Quiz generation error:', error);
    res.status(500).json({ error: 'Failed to generate quiz' });
  }
});

// Search & Get Quizzes
router.get('/search', auth, async (req, res) => {
  try {
    const { q, difficulty, gradeLevel } = req.query;
    let filter = {};

    if (q) {
      filter.$or = [
        { topic: { $regex: q, $options: 'i' } },
        { title: { $regex: q, $options: 'i' } },
        { description: { $regex: q, $options: 'i' } },
      ];
    }

    if (difficulty) {
      filter.difficulty = difficulty;
    }

    if (gradeLevel) {
      filter.gradeLevel = gradeLevel;
    }

    const quizzes = await Quiz.find(filter)
      .select('_id topic title description difficulty gradeLevel numberOfQuestions totalPoints timeLimit createdAt')
      .sort({ createdAt: -1 })
      .limit(50);

    res.json({
      count: quizzes.length,
      quizzes,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to search quizzes' });
  }
});

// Get Quiz by ID (for taking the quiz)
router.get('/:quizId', auth, async (req, res) => {
  try {
    const { quizId } = req.params;

    const quiz = await Quiz.findById(quizId);
    if (!quiz) {
      return res.status(404).json({ error: 'Quiz not found' });
    }

    res.json({
      quizId: quiz._id,
      topic: quiz.topic,
      title: quiz.title,
      numberOfQuestions: quiz.numberOfQuestions,
      totalPoints: quiz.totalPoints,
      timeLimit: quiz.timeLimit,
      passingScore: quiz.passingScore,
      difficulty: quiz.difficulty,
      gradeLevel: quiz.gradeLevel,
      questions: quiz.questions.map(q => ({
        id: q.id,
        question: q.question,
        type: q.type,
        options: q.options,
        difficulty: q.difficulty,
        points: q.points,
        // Correct answer hidden until submission
      })),
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch quiz' });
  }
});

// Submit Quiz Answers
router.post('/:quizId/submit', auth, async (req, res) => {
  try {
    const { quizId } = req.params;
    const { answers } = req.body; // Array of { questionId, answer }
    const userId = req.user.id;

    const quiz = await Quiz.findById(quizId);
    if (!quiz) {
      return res.status(404).json({ error: 'Quiz not found' });
    }

    // Calculate score
    let correctCount = 0;
    let totalPoints = 0;
    const results = [];

    quiz.questions.forEach((question) => {
      const userAnswer = answers.find(a => a.questionId === question.id);
      const isCorrect = userAnswer && userAnswer.answer.toLowerCase().trim() === question.correctAnswer.toLowerCase().trim();

      if (isCorrect) {
        correctCount++;
      }

      totalPoints += question.points || 10;

      results.push({
        questionId: question.id,
        question: question.question,
        type: question.type,
        userAnswer: userAnswer?.answer || 'Not answered',
        correctAnswer: question.correctAnswer,
        isCorrect,
        explanation: question.explanation,
        points: isCorrect ? (question.points || 10) : 0,
      });
    });

    const percentage = Math.round((correctCount / quiz.questions.length) * 100);
    const isPassed = percentage >= quiz.passingScore;

    // Save quiz attempt
    const attempt = new QuizAttempt({
      userId,
      quizId,
      answers,
      score: correctCount,
      totalQuestions: quiz.questions.length,
      percentage,
      passed: isPassed,
      timeTaken: req.body.timeTaken || 0,
      results,
    });

    await attempt.save();

    // Get user for potential badge award
    const user = await User.findById(userId);

    res.json({
      attemptId: attempt._id,
      score: correctCount,
      totalQuestions: quiz.questions.length,
      percentage,
      passed: isPassed,
      passingScore: quiz.passingScore,
      totalPoints,
      timeTaken: req.body.timeTaken,
      results,
      feedback: percentage >= 90 ? 'Outstanding! 🌟' : 
                percentage >= 75 ? 'Great job! 🎉' :
                percentage >= quiz.passingScore ? 'Good effort! Keep practicing 💪' :
                'Keep studying, you\'ll do better next time! 📚',
      message: isPassed ? 'You passed the quiz! 🎊' : 'Try again to pass! You can do it! 💪',
    });
  } catch (error) {
    console.error('Quiz submission error:', error);
    res.status(500).json({ error: 'Failed to submit quiz' });
  }
});

// Get Quiz Attempts History
router.get('/attempts/history/:userId', auth, async (req, res) => {
  try {
    const { userId } = req.params;

    if (req.user.id !== userId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const attempts = await QuizAttempt.find({ userId })
      .populate('quizId', 'topic title')
      .sort({ createdAt: -1 })
      .limit(50);

    res.json({
      attempts,
      totalAttempts: attempts.length,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch attempt history' });
  }
});

// Get Quiz Statistics
router.get('/:quizId/stats', auth, async (req, res) => {
  try {
    const { quizId } = req.params;
    const userId = req.user.id;

    const attempts = await QuizAttempt.find({ quizId, userId }).sort({ createdAt: -1 });

    if (attempts.length === 0) {
      return res.json({
        attempted: false,
        message: 'You haven\'t taken this quiz yet',
      });
    }

    const scores = attempts.map(a => a.percentage);
    const bestScore = Math.max(...scores);
    const averageScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    const passedAttempts = attempts.filter(a => a.passed).length;

    res.json({
      attempted: true,
      totalAttempts: attempts.length,
      bestScore,
      averageScore,
      passedAttempts,
      lastAttempt: attempts[0],
      allAttempts: attempts.map(a => ({
        attemptId: a._id,
        date: a.createdAt,
        score: a.percentage,
        passed: a.passed,
        timeTaken: a.timeTaken,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch quiz statistics' });
  }
});

// Popular Quiz Topics (for trending topics)
router.get('/topics/trending', async (req, res) => {
  try {
    const trendingTopics = await Quiz.aggregate([
      { $group: { _id: '$topic', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 20 },
    ]);

    res.json({
      trendingTopics: trendingTopics.map(t => ({
        topic: t._id,
        quizCount: t.count,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch trending topics' });
  }
});

module.exports = router;
