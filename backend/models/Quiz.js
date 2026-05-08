const mongoose = require('mongoose');

const quizSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    topic: {
      type: String,
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
    },
    description: String,
    questions: [
      {
        id: Number,
        question: String,
        type: {
          type: String,
          enum: ['multiple-choice', 'true-false', 'short-answer', 'essay', 'calculation'],
        },
        options: [String], // For multiple-choice and true-false
        correctAnswer: String,
        explanation: String,
        difficulty: {
          type: String,
          enum: ['easy', 'medium', 'hard'],
        },
        points: {
          type: Number,
          default: 10,
        },
      },
    ],
    numberOfQuestions: Number,
    totalPoints: Number,
    gradeLevel: {
      type: String,
      enum: ['grade-1-3', 'grade-4-6', 'grade-7-9', 'grade-10-plus'],
    },
    difficulty: {
      type: String,
      enum: ['easy', 'medium', 'hard', 'advanced'],
    },
    timeLimit: Number, // in seconds
    passingScore: Number, // percentage
    createdBy: {
      type: String,
      enum: ['ai', 'teacher', 'user'],
      default: 'ai',
    },
    isPublic: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Quiz', quizSchema);
