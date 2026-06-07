import React from 'react';
import { Link } from 'react-router-dom';

const Home: React.FC = () => {
  return (
    <div className="min-h-screen bg-gray-100 flex flex-col items-center justify-center p-4">
      <h1 className="text-4xl font-bold mb-8 text-blue-600">Welcome to Chat App</h1>
      <p className="text-xl mb-8 text-gray-700 text-center max-w-md">
        Select a chat room to start chatting with your friends and AI models.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 w-full max-w-2xl">
        <Link
          to="/chat/openclaw"
          className="bg-white p-6 rounded-lg shadow-md hover:shadow-lg transition-shadow border-t-4 border-green-500 text-center"
        >
          <h2 className="text-2xl font-semibold text-gray-800 mb-2">OpenClaw</h2>
          <p className="text-gray-600">Join the OpenClaw community chat room.</p>
        </Link>
        <Link
          to="/chat/hermes"
          className="bg-white p-6 rounded-lg shadow-md hover:shadow-lg transition-shadow border-t-4 border-purple-500 text-center"
        >
          <h2 className="text-2xl font-semibold text-gray-800 mb-2">Hermes</h2>
          <p className="text-gray-600">Chat with the Hermes AI model community.</p>
        </Link>
      </div>
    </div>
  );
};

export default Home;
